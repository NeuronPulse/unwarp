/**
 * IR -> SB3 blocks serializer.
 *
 * Reconstructs native Scratch SB3 block objects (the `blocks` map of a project.json
 * target) from unwarp's decompiler IR. The IR is byte-for-byte compatible with what
 * scratch-vm's jsgen consumes, so this module is the inverse of the compiler's `irgen`
 * block walk, mapping intermediate opcodes back to the SB3 opcodes/inputs/fields the
 * project originally had.
 *
 * Known fidelity limits (inherent to the compiled format, not this serializer):
 *  - procedure argument *names* and defaults are not in compiled JS (only p0..pN), so
 *    definitions are rebuilt as arg0..argN with empty defaults.
 *  - `hats` metadata from the compiled project stores field values uppercased; the
 *    provided `broadcastName` / `keyName` / `backdropName` callbacks restore case.
 */
import {
    IntermediateScript, IntermediateStack, IntermediateStackBlock, IntermediateInput,
    StackOpcode, InputOpcode, InputType,
} from '../decompiler/ir';
import { STACK_SPECS, REPORTER_SPECS, StackSpec, ReporterSpec, MenuInputSpec } from './opcodes';
import { DecompileError } from '../decompiler/types';

export interface ProcedureInfo {
    variant: string;
    /** Scratch proccode (variant minus the W/Z warp marker). */
    code: string;
    /** Number of arguments. */
    args: number;
    warp: boolean;
}

export interface SerializeContext {
    variableName: (id: string) => string;
    listName: (id: string) => string;
    isList: (id: string) => boolean;
    procedures: Map<string, ProcedureInfo>;
    procedureArgIds: Map<string, string[]>;
    /** Restore the true case of an uppercased broadcast name. */
    broadcastName?: (uppercased: string) => string;
    /** Restore the true case of an uppercased key option. */
    keyName?: (uppercased: string) => string;
    /** Restore the true case of an uppercased backdrop name. */
    backdropName?: (uppercased: string) => string;
    /** Argument ids of the procedure body currently being serialized. */
    currentArgIds?: string[];
}

function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h >>> 0;
}

export function procedureArgId(variant: string, index: number): string {
    return `arg_${(hashStr(variant) % 0xfffff).toString(36)}_${index}`;
}

// ---------------------------------------------------------------------------
// Block builder
// ---------------------------------------------------------------------------

class BlockBuilder {
    readonly blocks: Record<string, any> = {};
    private n = 0;

    private genId(): string {
        return `unwarp_${(++this.n).toString(36)}`;
    }

    /** Reserve an id (reusing a provided original id when free), store nothing yet. */
    reserve(id: string | null | undefined): string {
        if (id && !Object.prototype.hasOwnProperty.call(this.blocks, id)) return id;
        return this.genId();
    }

    set(id: string, obj: any): string {
        this.blocks[id] = obj;
        return id;
    }
}

// ---------------------------------------------------------------------------
// SB3 primitives
// ---------------------------------------------------------------------------

/** Serialize a numeric constant, guarding against non-JSON values. */
function numericPrimitive(value: number): any[] {
    let v: any = value;
    if (!Number.isFinite(v)) v = Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Infinity' : '-Infinity');
    return [4, v];
}

/** Serialize an IR constant into an inline SB3 shadow primitive. */
function primitiveForConstant(value: unknown): any[] {
    if (typeof value === 'number') return numericPrimitive(value);
    if (typeof value === 'boolean') return [4, value ? 1 : 0];
    if (Array.isArray(value)) {
        // jsgen colour constant: [r, g, b] (0-255) -> #rrggbb
        const hex = (n: unknown) => {
            const x = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
            return x.toString(16).padStart(2, '0');
        };
        return [9, `#${hex(value[0])}${hex(value[1])}${hex(value[2])}`];
    }
    return [10, String(value)];
}

function constString(input: IntermediateInput): string | null {
    if (input.opcode === InputOpcode.CONSTANT) return String(input.inputs.value);
    return null;
}

/** A variable/list reference descriptor from the IR. */
function isVarRef(v: unknown): v is { scope: string; id: string; name: string; isCloud: boolean } {
    return !!v && typeof v === 'object' && typeof (v as any).id === 'string' &&
        ((v as any).scope === 'target' || (v as any).scope === 'stage');
}

// ---------------------------------------------------------------------------
// Input / reporter serialization
// ---------------------------------------------------------------------------

/** Serialize an IR reporter/constant input value into an SB3 input descriptor. */
function serializeInput(builder: BlockBuilder, value: unknown, ctx: SerializeContext, parentId: string | null): any[] {
    if (value instanceof IntermediateInput) {
        const op = value.opcode;
        if (op === InputOpcode.CONSTANT) return [1, primitiveForConstant(value.inputs.value)];
        if (op === InputOpcode.VAR_GET) {
            const v = value.inputs.variable;
            const id = v && v.id;
            const name = ctx.variableName(id);
            return [1, [12, name, id]];
        }
        if (op === InputOpcode.LIST_CONTENTS) {
            const v = value.inputs.list;
            const id = v && v.id;
            const name = ctx.listName(id);
            return [1, [13, name, id]];
        }
        if (op === InputOpcode.PROCEDURE_ARGUMENT) {
            const index = Number(value.inputs.index);
            // irgen looks up this value in the prototype's `argumentnames`, so it must be
            // the parameter name (arg0, arg1, ...) that serializeProcedureDefinition writes.
            const name = `arg${index}`;
            const bid = builder.reserve(null);
            builder.set(bid, {
                opcode: 'argument_reporter_string_number',
                next: null,
                parent: parentId,
                inputs: {},
                fields: { VALUE: [name] },
            });
            return [1, bid];
        }
        if (op === InputOpcode.COMPATIBILITY_LAYER) {
            const rid = serializeCompatReporter(builder, value, ctx, parentId);
            return [1, rid];
        }
        // Type casts (cast.toNumber, cast.toString, etc.) are compiler hints, not SB3 blocks.
        // Unwrap: serialize the inner target directly.
        if (op === InputOpcode.CAST_NUMBER || op === InputOpcode.CAST_NUMBER_INDEX ||
            op === InputOpcode.CAST_NUMBER_OR_NAN || op === InputOpcode.CAST_STRING ||
            op === InputOpcode.CAST_BOOLEAN || op === InputOpcode.CAST_COLOR) {
            return serializeInput(builder, value.inputs.target, ctx, parentId);
        }
        const sid = serializeReporter(builder, op, value, ctx, parentId);
        return [1, sid];
    }
    throw new DecompileError(`cannot serialize input value: ${JSON.stringify(value)}`);
}

function serializeReporter(builder: BlockBuilder, op: string, input: IntermediateInput, ctx: SerializeContext, parentId: string | null): string {
    const sensing = sensingOfReporter(op, input);
    if (sensing) {
        return serializeGenericReporter(builder, sensing.opcode, sensing, input, ctx, parentId);
    }

    const spec = REPORTER_SPECS[op];
    if (!spec) throw new DecompileError(`cannot serialize reporter opcode: ${op}`);
    return serializeSpecReporter(builder, spec, input, ctx, parentId);
}

interface GenericSpec {
    opcode: string;
    fields?: Record<string, string>;
    inputs?: Record<string, string>;
    constFields?: Record<string, string>;
    menuInputs?: Record<string, MenuInputSpec>;
    fixedFields?: Record<string, string>;
    uppercaseFields?: string[];
    substacks?: Record<string, string>;
    listField?: string;
    varField?: string;
}

function serializeGenericReporter(builder: BlockBuilder, opcode: string, spec: GenericSpec, input: IntermediateInput, ctx: SerializeContext, parentId: string | null): string {
    const id = builder.reserve(null);
    const obj: any = { opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    applySpec(builder, obj, id, spec, input, ctx);
    return id;
}

function serializeSpecReporter(builder: BlockBuilder, spec: ReporterSpec, input: IntermediateInput, ctx: SerializeContext, parentId: string | null): string {
    const id = builder.reserve(null);
    const obj: any = { opcode: spec.opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    applySpec(builder, obj, id, spec as GenericSpec, input, ctx);
    return id;
}

/**
 * Apply a reporter/stack spec onto an already-reserved block object: fixed fields,
 * constant fields, reporter inputs and (for stack blocks) substacks / var / list fields.
 */
function applySpec(builder: BlockBuilder, obj: any, id: string, spec: GenericSpec, input: any, ctx: SerializeContext): void {
    for (const [field, value] of Object.entries(spec.fixedFields || {})) {
        obj.fields[field] = [value];
    }
    for (const [field, value] of Object.entries(spec.fields || {})) {
        obj.fields[field] = [value];
    }
    const upperFields = new Set(spec.uppercaseFields || []);
    for (const [irKey, fieldName] of Object.entries(spec.constFields || {})) {
        if (irKey === 'none') continue;
        const v = input.inputs?.[irKey];
        let raw: string | null = null;
        if (v instanceof IntermediateInput && v.opcode === InputOpcode.CONSTANT) {
            raw = String(v.inputs.value);
        } else if (typeof v === 'string') {
            raw = v;
        } else if (typeof v === 'number' || typeof v === 'boolean') {
            raw = String(v);
        }
        if (raw !== null) {
            obj.fields[fieldName] = [upperFields.has(fieldName) ? raw.toUpperCase() : raw];
        }
    }
    const handledInputs = new Set<string>();
    for (const [irKey, menu] of Object.entries(spec.menuInputs || {})) {
        if (irKey === 'none') continue;
        const v = input.inputs?.[irKey];
        let fieldValue: string | null = null;
        if (v instanceof IntermediateInput && v.opcode === InputOpcode.CONSTANT) {
            fieldValue = String(v.inputs.value);
        } else if (typeof v === 'string') {
            fieldValue = v;
        } else if (typeof v === 'number' || typeof v === 'boolean') {
            fieldValue = String(v);
        }
        if (fieldValue === null) continue;
        handledInputs.add(menu.input);
        // irgen descends these as inputs; the input must be a shadow menu block.
        const menuId = builder.reserve(null);
        builder.set(menuId, {
            opcode: menu.menuOpcode,
            next: null,
            parent: id,
            inputs: {},
            fields: { [menu.field]: [fieldValue] },
            shadow: true,
        });
        obj.inputs[menu.input] = [1, menuId];
    }
    if (spec.varField) {
        const v = input.inputs?.variable;
        if (isVarRef(v)) {
            obj.fields[spec.varField] = [ctx.variableName(v.id), v.id];
        } else {
            obj.fields[spec.varField] = ['', 'unwarp_missing_var'];
        }
    }
    if (spec.listField) {
        const v = input.inputs?.list;
        if (isVarRef(v)) {
            obj.fields[spec.listField] = [ctx.listName(v.id), v.id];
        } else {
            obj.fields[spec.listField] = ['', 'unwarp_missing_list'];
        }
    }
    for (const [irKey, sb3Name] of Object.entries(spec.inputs || {})) {
        if (handledInputs.has(sb3Name)) continue;
        const v = input.inputs?.[irKey];
        if (v === undefined) continue;
        obj.inputs[sb3Name] = serializeInput(builder, v, ctx, id);
    }
    for (const [irKey, sb3Name] of Object.entries(spec.substacks || {})) {
        const stack = input.inputs?.[irKey];
        if (!(stack instanceof IntermediateStack)) continue;
        const first = serializeStackChain(builder, stack.blocks, ctx, id);
        if (first !== null) obj.inputs[sb3Name] = [2, first];
    }
}

// ---------------------------------------------------------------------------
// sensing.of reporters
// ---------------------------------------------------------------------------

const SENSING_OF_PROPERTY: Record<string, string> = {
    'sensing.of.x': 'x position',
    'sensing.of.y': 'y position',
    'sensing.of.direction': 'direction',
    'sensing.of.size': 'size',
    'sensing.of.volume': 'volume',
    'sensing.of.backdropNumber': 'backdrop #',
    'sensing.of.backdropName': 'backdrop name',
    'sensing.of.costumeNumber': 'costume #',
    'sensing.of.costumeName': 'costume name',
};

/** Map a `sensing.of.*` IR opcode to a serializable reporter spec, or null. */
function sensingOfReporter(op: string, input: IntermediateInput): GenericSpec | null {
    if (op === 'sensing.of') {
        const property = String(input.inputs.property ?? '');
        return {
            opcode: 'sensing_of',
            fields: { PROPERTY: property },
            inputs: { object: 'OBJECT' },
        };
    }
    if (op === 'sensing.of.var') {
        return {
            opcode: 'sensing_of',
            fields: { PROPERTY: String(input.inputs.property ?? '') },
            inputs: { object: 'OBJECT' },
        };
    }
    const property = SENSING_OF_PROPERTY[op];
    if (!property) return null;
    // backdrop of the stage serializes to the stage-only looks reporter.
    const object = input.inputs.object;
    if ((op === 'sensing.of.backdropNumber' || op === 'sensing.of.backdropName') &&
        object instanceof IntermediateInput && object.opcode === InputOpcode.CONSTANT &&
        object.inputs.value === '_stage_') {
        return {
            opcode: 'looks_backdropnumbername',
            fields: { NUMBER_NAME: op === 'sensing.of.backdropNumber' ? 'number' : 'name' },
        };
    }
    return {
        opcode: 'sensing_of',
        fields: { PROPERTY: property },
        inputs: { object: 'OBJECT' },
    };
}

// ---------------------------------------------------------------------------
// Compatibility-layer blocks
// ---------------------------------------------------------------------------

/** A compat reporter keeps its original block id; reconstruct it directly. */
function serializeCompatReporter(builder: BlockBuilder, input: IntermediateInput, ctx: SerializeContext, parentId: string | null): string {
    const payload = input.inputs;
    const id = builder.reserve(payload.id);
    const obj: any = { opcode: payload.opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    for (const [k, v] of Object.entries(payload.fields || {})) {
        obj.fields[k] = [String(v)];
    }
    for (const [k, v] of Object.entries(payload.inputs || {})) {
        obj.inputs[k] = serializeInput(builder, v, ctx, id);
    }
    return id;
}

/** A compat stack/command/conditional/loop block keeps its original block id. */
function serializeCompatStack(builder: BlockBuilder, block: IntermediateStackBlock, ctx: SerializeContext, parentId: string | null): string {
    const payload = block.inputs;
    const id = builder.reserve(payload.id);
    const obj: any = { opcode: payload.opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    for (const [k, v] of Object.entries(payload.fields || {})) {
        obj.fields[k] = [String(v)];
    }
    for (const [k, v] of Object.entries(payload.inputs || {})) {
        obj.inputs[k] = serializeInput(builder, v, ctx, id);
    }
    for (const [num, stack] of Object.entries(payload.substacks || {})) {
        const sb3Name = num === '2' ? 'SUBSTACK2' : 'SUBSTACK';
        const first = serializeStackChain(builder, (stack as IntermediateStack).blocks, ctx, id);
        if (first !== null) obj.inputs[sb3Name] = [2, first];
    }
    return id;
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

function serializeProcedureCall(builder: BlockBuilder, block: IntermediateStackBlock, ctx: SerializeContext, parentId: string | null): string {
    const variant = block.inputs.variant as string;
    const proc = ctx.procedures.get(variant);
    const code = proc ? proc.code : (typeof variant === 'string' ? variant.substring(1) : '');
    const argIds = ctx.procedureArgIds.get(variant) ?? [];
    const mutation = {
        tagName: 'mutation',
        children: [],
        proccode: code,
        argumentids: JSON.stringify(argIds),
        warp: proc && proc.warp ? 'true' : 'false',
    };
    const id = builder.reserve(null);
    const obj: any = { opcode: 'procedures_call', next: null, parent: parentId, inputs: {}, fields: {}, mutation };
    builder.set(id, obj);
    const args = block.inputs.arguments as IntermediateInput[] | undefined;
    if (Array.isArray(args)) {
        for (let i = 0; i < args.length; i++) {
            const aid = argIds[i];
            if (!aid) break;
            obj.inputs[aid] = serializeInput(builder, args[i], ctx, id);
        }
    }
    return id;
}

// ---------------------------------------------------------------------------
// Broadcast blocks
// ---------------------------------------------------------------------------

function serializeBroadcast(builder: BlockBuilder, block: IntermediateStackBlock, ctx: SerializeContext, parentId: string | null): string {
    const opcode = block.opcode === StackOpcode.EVENT_BROADCAST_AND_WAIT ? 'event_broadcastandwait' : 'event_broadcast';
    const id = builder.reserve(null);
    const obj: any = { opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    const br = block.inputs.broadcast;
    if (br instanceof IntermediateInput && br.opcode === InputOpcode.CONSTANT) {
        const name = ctx.broadcastName ? ctx.broadcastName(String(br.inputs.value)) : String(br.inputs.value);
        const bid = broadcastIdFor(String(br.inputs.value));
        obj.fields.BROADCAST_OPTION = [name, bid];
        obj.inputs.BROADCAST_INPUT = [1, [11, name, bid]];
    } else if (br !== undefined) {
        obj.inputs.BROADCAST_INPUT = serializeInput(builder, br, ctx, id);
    }
    return id;
}

let _broadcastCounter = 0;
const _broadcastIdCache = new Map<string, string>();
function broadcastIdFor(name: string): string {
    let id = _broadcastIdCache.get(name);
    if (id) return id;
    _broadcastCounter += 1;
    id = `bc_${hashStr(name).toString(36)}_${_broadcastCounter}`;
    _broadcastIdCache.set(name, id);
    return id;
}

// ---------------------------------------------------------------------------
// Stack serialization
// ---------------------------------------------------------------------------

/** Blocks that don't produce an SB3 block at this position (hat markers etc.). */
function isNonBlockOpcode(op: string): boolean {
    return op === StackOpcode.HAT_EDGE || op === StackOpcode.HAT_PREDICATE ||
        op === StackOpcode.VISUAL_REPORT || op === StackOpcode.DEBUGGER ||
        op === StackOpcode.NOP || op === StackOpcode.ADDON_CALL;
}

/**
 * Serialize a list of IR stack blocks into an SB3 block chain.
 * @returns the id of the first block, or null when there is nothing to emit.
 */
export function serializeStackChain(builder: BlockBuilder, blocks: IntermediateStackBlock[], ctx: SerializeContext, parentId: string | null): string | null {
    let first: string | null = null;
    let prev: string | null = null;
    for (const b of blocks) {
        if (isNonBlockOpcode(b.opcode)) continue;
        const id = serializeStackBlock(builder, b, ctx, prev ?? parentId);
        if (!first) first = id;
        if (prev !== null) builder.blocks[prev].next = id;
        prev = id;
    }
    return first;
}

function serializeStackBlock(builder: BlockBuilder, block: IntermediateStackBlock, ctx: SerializeContext, parentId: string | null): string {
    const op = block.opcode;
    if (op === StackOpcode.COMPATIBILITY_LAYER || op === StackOpcode.OLD_COMPILER_COMPATIBILITY_LAYER) {
        return serializeCompatStack(builder, block, ctx, parentId);
    }
    if (op === StackOpcode.PROCEDURE_CALL) {
        return serializeProcedureCall(builder, block, ctx, parentId);
    }
    if (op === StackOpcode.EVENT_BROADCAST || op === StackOpcode.EVENT_BROADCAST_AND_WAIT) {
        return serializeBroadcast(builder, block, ctx, parentId);
    }
    const spec = stackSpecFor(block);
    if (!spec) throw new DecompileError(`cannot serialize stack opcode: ${op}`);

    const id = builder.reserve(null);
    const obj: any = { opcode: spec.opcode, next: null, parent: parentId, inputs: {}, fields: {} };
    builder.set(id, obj);
    applySpec(builder, obj, id, spec, effectiveBlockFor(block), ctx);
    return id;
}

/** True when a CONTROL_WHILE's condition is a negation, i.e. the block is a `repeat until`. */
function isRepeatUntil(block: IntermediateStackBlock): boolean {
    const condition = block.inputs.condition;
    return block.opcode === StackOpcode.CONTROL_WHILE &&
        condition instanceof IntermediateInput &&
        condition.opcode === InputOpcode.OP_NOT;
}

/** True for VAR_SET whose value is `<the same variable> + n`, i.e. a "change variable by". */
function isVariableChange(block: IntermediateStackBlock): boolean {
    if (block.opcode !== StackOpcode.VAR_SET) return false;
    const value = block.inputs.value;
    if (!(value instanceof IntermediateInput) || value.opcode !== InputOpcode.OP_ADD) return false;
    const left = value.inputs.left;
    if (!(left instanceof IntermediateInput) || left.opcode !== InputOpcode.VAR_GET) return false;
    const target = block.inputs.variable;
    const source = left.inputs.variable;
    return !!target && !!source && target.id === source.id && target.scope === source.scope;
}

/** True for CONTROL_WHILE with a constant `true` condition, i.e. a `forever` loop. */
function isForever(block: IntermediateStackBlock): boolean {
    const condition = block.inputs.condition;
    return block.opcode === StackOpcode.CONTROL_WHILE &&
        condition instanceof IntermediateInput &&
        condition.opcode === InputOpcode.CONSTANT &&
        condition.inputs.value === true;
}

/**
 * Pick the SB3 form for a stack block.
 *
 * Several IR shapes do not map 1:1 onto Scratch blocks because irgen (02scratch-vm) merges
 * them, so the serializer has to disambiguate:
 *  - `control_if` becomes CONTROL_IF_ELSE with an *empty* `whenFalse` substack; emitting
 *    `control_if_else` unconditionally would turn every plain "if" into an "if/else".
 *  - `control_forever` becomes CONTROL_WHILE with a constant `true` condition (`while (true)`).
 *  - `control_repeat_until` becomes CONTROL_WHILE whose condition is OP_NOT; emitting
 *    `control_while` would flip the block and leave a spurious `operator_not` behind.
 *  - `change variable by` becomes VAR_SET(X, OP_ADD(VAR_GET(X), n)), identical to a
 *    hand-written `set X to (X + n)`; prefer the single "change" block.
 *
 * These forms do not exist in scratch-vm's IR enum, so they live here (sb3 side) rather than
 * in ir.ts, which stays a faithful mirror of the compiler's opcodes.
 */
function stackSpecFor(block: IntermediateStackBlock): StackSpec | undefined {
    const op = block.opcode;

    if (isVariableChange(block)) return STACK_SPECS['var.set.change'];

    if (op === StackOpcode.CONTROL_IF_ELSE) {
        const whenFalse = block.inputs.whenFalse;
        const emptyFalse = !(whenFalse instanceof IntermediateStack) || whenFalse.blocks.length === 0;
        return STACK_SPECS[emptyFalse ? 'control.if.only' : 'control.if'];
    }

    if (op === StackOpcode.CONTROL_WHILE) {
        if (isForever(block)) return STACK_SPECS['control.forever'];
        if (isRepeatUntil(block)) return STACK_SPECS['control.repeatUntil'];
    }

    return STACK_SPECS[op];
}

/**
 * The block to read inputs from when applying a spec.
 *
 * A `repeat until` is stored as `while (not C)`; once the block is emitted as
 * `control_repeat_until` the negation belongs to the block itself, so the condition read for
 * CONDITION must be `C`, not `not C`.
 */
function effectiveBlockFor(block: IntermediateStackBlock): IntermediateStackBlock {
    const overrides: Record<string, unknown> = {};

    // A `repeat until` is stored as `while (not C)`; once the block is emitted as
    // `control_repeat_until` the negation belongs to the block itself, so CONDITION reads `C`.
    if (isRepeatUntil(block)) {
        overrides.condition = (block.inputs.condition as IntermediateInput).inputs.operand;
    }
    // Likewise, once VAR_SET is emitted as `change variable by`, VALUE is the delta alone --
    // the `X +` half is implicit in the block.
    if (isVariableChange(block)) {
        overrides.value = (block.inputs.value as IntermediateInput).inputs.right;
    }

    if (!Object.keys(overrides).length) return block;
    return Object.assign(Object.create(Object.getPrototypeOf(block)), block, {
        inputs: { ...block.inputs, ...overrides },
    });
}

// ---------------------------------------------------------------------------
// Script assembly
// ---------------------------------------------------------------------------

export interface HatData {
    topBlockId: string;
    opcode: string;
    fieldsOfInputs: Record<string, { value: string; id?: string }>;
}

export interface TargetIR {
    /** topBlockId -> decompiled script (hats and plain scripts). */
    scripts: Record<string, IntermediateScript>;
    /** procedure variant -> decompiled procedure body. */
    procedures: Record<string, IntermediateScript>;
    hats: HatData[];
}

export interface SerializedTarget {
    /** SB3 `blocks` map for the target. */
    blocks: Record<string, any>;
}

const HAT_FIELD_NAMES: Record<string, string> = {
    event_whenbackdropswitchesto: 'BACKDROP',
    event_whenkeypressed: 'KEY_OPTION',
    event_whenbroadcastreceived: 'BROADCAST_OPTION',
    event_whentouchingobject: 'TOUCHINGOBJECTMENU',
    event_whengreaterthan: 'WHENGREATERTHANMENU',
    sensing_when_touchingobject: 'TOUCHINGOBJECTMENU',
};

/**
 * Serialize the hats/scripts/procedures of one target into an SB3 blocks map.
 * Procedure definitions are rebuilt with a definition + prototype pair; edge/predicate
 * hats are rebuilt from the `hats` metadata captured by the compiled project.
 */
export function serializeTargetBlocks(target: TargetIR, ctx: SerializeContext, layout = { x: 60, y: 60 }): SerializedTarget {
    const builder = new BlockBuilder();
    const hatByTop = new Map<string, HatData>();
    for (const h of target.hats) hatByTop.set(h.topBlockId, h);

    // Variants that already got a procedures_definition (via a `procedures_definition` hat
    // entry), so the fallback pass below does not emit a second one.
    const definedProcedures = new Set<string>();

    for (const topBlockId of Object.keys(target.scripts)) {
        const script = target.scripts[topBlockId];
        if (!script.stack) continue;
        const hat = hatByTop.get(topBlockId);

        const body = serializeStackChain(builder, script.stack.blocks, ctx, hat ? null : null);
        // parent of the first body block is patched below (hat / definition / top-level).

        if (hat && hat.opcode === 'procedures_definition') {
            serializeProcedureDefinition(builder, script, topBlockId, ctx, layout);
            if (script.procedureVariant) definedProcedures.add(script.procedureVariant);
            continue;
        }

        if (hat) {
            const hatId = builder.reserve(topBlockId);
            // The compiled format's hat metadata keeps dropdown values uppercased (RuntimeScriptCache
            // uppercases them for hat matching), but the compiled factory JS carries the true case:
            // irgen descends a hat head as a COMPATIBILITY_LAYER with its fields intact, so a recovered
            // HAT_EDGE/HAT_PREDICATE condition restores original case for case-sensitive menu values
            // (sprite names in "when touching", broadcast/backdrop names). Prefer it over metadata.
            const head = script.stack.blocks[0];
            let compatHeadFields: Record<string, string> | null = null;
            if (head && (head.opcode === StackOpcode.HAT_EDGE || head.opcode === StackOpcode.HAT_PREDICATE)) {
                const cond = head.inputs.condition;
                if (cond instanceof IntermediateInput && cond.opcode === InputOpcode.COMPATIBILITY_LAYER &&
                    cond.inputs.opcode === hat.opcode && cond.inputs.fields) {
                    compatHeadFields = cond.inputs.fields;
                }
            }
            const fields = serializeHatFields(hat, ctx, compatHeadFields);
            const obj: any = {
                opcode: hat.opcode,
                next: null,
                parent: null,
                inputs: {},
                fields,
                topLevel: true,
                x: layout.x,
                y: layout.y,
            };
            builder.set(hatId, obj);
            layout.y += 40;
            if (body !== null) {
                obj.next = body;
                builder.blocks[body].parent = hatId;
            }
            // event_whengreaterthan carries a VALUE input the compiler captured in HAT_EDGE.
            // The condition is a COMPATIBILITY_LAYER whose inputs/fields hold the threshold
            // reporter; extract it directly rather than serializing the whole compat block
            // (which would wrongly nest an event_whengreaterthan block under VALUE).
            if (hat.opcode === 'event_whengreaterthan' && head && head.opcode === StackOpcode.HAT_EDGE &&
                head.inputs.condition instanceof IntermediateInput &&
                head.inputs.condition.opcode === InputOpcode.COMPATIBILITY_LAYER) {
                const condPayload = head.inputs.condition.inputs;
                const valueInput = condPayload.inputs?.VALUE;
                if (valueInput instanceof IntermediateInput) {
                    obj.inputs.VALUE = serializeInput(builder, valueInput, ctx, hatId);
                } else if (typeof condPayload.fields?.VALUE === 'string' || typeof condPayload.fields?.VALUE === 'number') {
                    const v = condPayload.fields.VALUE;
                    const constInput = new IntermediateInput(InputOpcode.CONSTANT, typeof v === 'number' ? IntermediateInput.getNumberInputType(v) : InputType.STRING, { value: v });
                    obj.inputs.VALUE = serializeInput(builder, constInput, ctx, hatId);
                }
            }
            continue;
        }

        // Plain top-level script: no hat block; first block is topLevel.
        if (body !== null) {
            builder.blocks[body].parent = null;
            builder.blocks[body].topLevel = true;
            builder.blocks[body].x = layout.x;
            builder.blocks[body].y = layout.y;
            layout.y += 40;
        }
    }

    // 02scratch-vm only records a `hats` entry when `runtime.getIsHat(topBlock.opcode)` is
    // true, and `procedures_definition` is NOT a hat -- so the compiled data never carries
    // hat metadata for custom blocks. Without this fallback pass every custom block would
    // vanish from the rebuilt project. Emit a definition for every procedure that the hat
    // pass did not already cover.
    for (const [variant, script] of Object.entries(target.procedures)) {
        if (definedProcedures.has(variant)) continue;
        if (script.procedureVariant && script.procedureVariant !== variant) {
            definedProcedures.add(script.procedureVariant);
        }
        serializeProcedureDefinition(builder, script, null, ctx, layout);
    }

    return { blocks: builder.blocks };
}

/** Fields for a hat block, restoring case where the format uppercased them. */
function serializeHatFields(hat: HatData, ctx: SerializeContext, compatFields: Record<string, string> | null = null): Record<string, any> {
    const fields: Record<string, any> = {};
    for (const [name, field] of Object.entries(hat.fieldsOfInputs)) {
        // The recovered hat-head compat condition (if any) holds the field's true case.
        const realCase = compatFields ? compatFields[name] : undefined;
        if (typeof realCase === 'string') {
            fields[name] = [realCase, ...(field.id !== undefined ? [field.id] : [])];
            continue;
        }
        if (HAT_FIELD_NAMES[hat.opcode] === name && field.value && typeof field.value === 'string') {
            if (name === 'KEY_OPTION') {
                fields[name] = [ctx.keyName ? ctx.keyName(field.value) : field.value.toLowerCase()];
                continue;
            }
            if (name === 'BROADCAST_OPTION') {
                const restored = ctx.broadcastName ? ctx.broadcastName(field.value) : field.value;
                fields[name] = [restored, field.id];
                continue;
            }
            if (name === 'BACKDROP') {
                const restored = ctx.backdropName ? ctx.backdropName(field.value) : field.value;
                fields[name] = [restored];
                continue;
            }
        }
        fields[name] = [field.value, ...(field.id !== undefined ? [field.id] : [])];
    }
    return fields;
}

/** Build the procedures_definition + procedures_prototype pair and the body chain. */
function serializeProcedureDefinition(builder: BlockBuilder, script: IntermediateScript, topBlockId: string | null, ctx: SerializeContext, layout: { x: number; y: number }): void {
    const variant = script.procedureVariant;
    const proc = ctx.procedures.get(variant);
    const code = proc ? proc.code : (variant ? variant.substring(1) : 'unknown');
    const argIds = ctx.procedureArgIds.get(variant) ?? [];
    const argNames = argIds.map((_, i) => `arg${i}`);

    const defId = builder.reserve(topBlockId);
    const mutation = {
        tagName: 'mutation',
        children: [],
        proccode: code,
        argumentids: JSON.stringify(argIds),
        argumentnames: JSON.stringify(argNames),
        argumentdefaults: JSON.stringify(argIds.map(() => '')),
        warp: proc && proc.warp ? 'true' : 'false',
    };

    const prototypeId = builder.reserve(null);
    const prototype: any = {
        opcode: 'procedures_prototype',
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: true,
        mutation,
    };
    builder.set(prototypeId, prototype);

    const definition: any = {
        opcode: 'procedures_definition',
        next: null,
        parent: null,
        inputs: { custom_block: [1, prototypeId] },
        fields: {},
        topLevel: true,
        x: layout.x,
        y: layout.y,
    };
    builder.set(defId, definition);
    prototype.parent = defId;
    layout.y += 40;

    for (let ai = 0; ai < argIds.length; ai++) {
        const aid = argIds[ai];
        const argShadowId = builder.reserve(null);
        builder.set(argShadowId, {
            opcode: 'argument_reporter_string_number',
            next: null,
            parent: prototypeId,
            inputs: {},
            // Must match the prototype's `argumentnames` entry: irgen resolves a
            // PROCEDURE_ARGUMENT by looking this name up, not by id.
            fields: { VALUE: [argNames[ai]] },
            shadow: true,
        });
        prototype.inputs[aid] = [1, argShadowId];
    }

    if (script.stack) {
        const prevArgs = ctx.currentArgIds;
        ctx.currentArgIds = argIds;
        const body = serializeStackChain(builder, script.stack.blocks, ctx, defId);
        ctx.currentArgIds = prevArgs;
        if (body !== null) {
            definition.next = body;
            builder.blocks[body].parent = defId;
        }
    }
}

// ---------------------------------------------------------------------------
// Procedure helpers
// ---------------------------------------------------------------------------

/** Build a SerializeContext for a target from its compiled-project data + IR. */
export interface CompiledTargetData {
    targetIndex: number;
    name: string;
    isStage: boolean;
    scripts: Record<string, { factorySource?: string; executableHat?: boolean }>;
    procedures: Record<string, { factorySource?: string }>;
    hats: HatData[];
}

/** Collect procedure info + argument ids from a set of decompiled procedure scripts. */
export function buildProcedureInfo(procedures: Record<string, IntermediateScript>): {
    info: Map<string, ProcedureInfo>;
    argIds: Map<string, string[]>;
} {
    const info = new Map<string, ProcedureInfo>();
    const argIds = new Map<string, string[]>();
    for (const [variant, script] of Object.entries(procedures)) {
        const code = script.procedureCode || (variant ? variant.substring(1) : '');
        const args = script.arguments ? script.arguments.length : 0;
        info.set(variant, { variant, code, args, warp: !!script.isWarp });
        const ids: string[] = [];
        for (let i = 0; i < args; i++) ids.push(procedureArgId(variant, i));
        argIds.set(variant, ids);
    }
    return { info, argIds };
}

export { DecompileError };
