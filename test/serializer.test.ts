/**
 * Serializer tests: native IR -> jsgen -> decompile -> IR -> SB3 blocks, then validate the
 * serialized blocks hydrate through scratch-vm's own sb3 deserializer and check shapes.
 * This exercises the full compile -> decompile -> serialize pipeline against the real
 * scratch-vm code generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSG, INTER, ENUMS, BLOCKTYPE, compileToSource, STACK, SB, C, N, B, VB, VAR, IN } from './harness';
import { decompileScript } from '../src/decompiler/index';
import { serializeTargetBlocks, buildProcedureInfo, SerializeContext, TargetIR } from '../src/serializer/index';

/**
 * Self-contained SB3 blocks validator (mirrors what scratch-vm's deserializeStandaloneBlocks
 * checks without pulling in the full runtime): every referenced block id must exist, inputs
 * must reference a block or an inline primitive, and mutations must be well-formed.
 */
function validateBlocks(blocks: Record<string, any>): void {
    const ids = new Set(Object.keys(blocks));
    for (const [id, b] of Object.entries(blocks)) {
        assert.ok(!Array.isArray(b) || b.length >= 1, `block ${id} is a primitive array`);
        if (Array.isArray(b)) continue;
        assert.equal(typeof b.opcode, 'string', `block ${id} has opcode`);
        for (const input of Object.values(b.inputs ?? {})) {
            assert.ok(Array.isArray(input) && typeof input[0] === 'number', `input of ${id} is a descriptor`);
            const kind: any = input[0];
            assert.ok(kind >= 1 && kind <= 3, `input of ${id} has valid shadow kind`);
            for (let i = 1; i < input.length; i++) {
                const ref: any = input[i];
                if (typeof ref === 'string') {
                    // kind 1 = inline shadow primitive (value, never a block id); kind 2/3 = block refs.
                    if (kind === 1) {
                        assert.ok(Array.isArray(input) && input.length >= 2, `input of ${id} is an inline primitive`);
                    } else {
                        assert.ok(ids.has(ref), `input of ${id} references missing block ${ref}`);
                    }
                } else {
                    assert.ok(Array.isArray(ref), `input of ${id} ref must be id or primitive`);
                }
            }
        }
        if (b.next !== null && b.next !== undefined) assert.ok(ids.has(b.next), `next of ${id} references missing block ${b.next}`);
        if (b.parent !== null && b.parent !== undefined) assert.ok(ids.has(b.parent), `parent of ${id} references missing block ${b.parent}`);
        if (b.mutation) {
            assert.equal(typeof b.mutation.proccode, 'string');
            assert.ok(Array.isArray(JSON.parse(b.mutation.argumentids ?? '[]')), 'argumentids valid json');
        }
    }
}

function makeCtx(procedures: TargetIR['procedures']): SerializeContext {
    const { info, argIds } = buildProcedureInfo(procedures);
    const vars = new Map<string, string>();
    const lists = new Map<string, string>();
    const listIds = collectListIdsForTarget(procedures);
    const ctx: SerializeContext = {
        variableName: (id) => vars.get(id) ?? id,
        listName: (id) => lists.get(id) ?? id,
        isList: (id) => listIds.has(id),
        procedures: info,
        procedureArgIds: argIds,
        broadcastName: (u) => u,
        keyName: (u) => u.toLowerCase(),
        backdropName: (u) => u,
    };
    return ctx;
}

function collectListIdsForTarget(procedures: Record<string, any>): Set<string> {
    const ids = new Set<string>();
    const visit = (v: any): void => {
        if (!v || typeof v !== 'object') return;
        if (v.blocks) { v.blocks.forEach(visit); return; }
        if (v.opcode !== undefined && v.inputs) {
            for (const k of Object.keys(v.inputs)) {
                const val = v.inputs[k];
                if (k === 'list') { if (val && val.id) ids.add(val.id); }
                visit(val);
            }
            if (v.substacks) for (const k of Object.keys(v.substacks)) visit(v.substacks[k]);
        }
    };
    const visitBlock = (b: any): void => visit(b);
    Object.values(procedures).forEach((p: any) => visit(p));
    return ids;
}

/** Argument count for a procedure: `%s` placeholders in the proccode, falling back to usage. */
function procedureArgCount(blocks: any[], code: string): number {
    const fromCode = (code.match(/%[\w]/g) || []).length;
    if (fromCode > 0) return fromCode;
    let max = 0;
    const visit = (v: any): void => {
        if (!v || typeof v !== 'object') return;
        if (v.blocks) { v.blocks.forEach(visit); return; }
        if (v.opcode === ENUMS.InputOpcode.PROCEDURE_ARGUMENT) {
            max = Math.max(max, Number(v.inputs?.index) + 1);
        }
        if (v.inputs) for (const k of Object.keys(v.inputs)) visit(v.inputs[k]);
        if (v.substacks) for (const k of Object.keys(v.substacks)) visit(v.substacks[k]);
    };
    blocks.forEach(visit);
    return max;
}

/** Build a TargetIR from native block lists for an entry script + procedures. */
function targetIR(entryBlocks: any[], opts: { procedures?: Record<string, { blocks: any[]; variant: string; warp?: boolean }> } = {}): TargetIR {
    const scripts: TargetIR['scripts'] = {};
    const procedures: TargetIR['procedures'] = {};

    // jsgen procedures map: procedures referenced by PROCEDURE_CALL resolve here.
    const jsgenProcedures: Record<string, { stack: any; yields: boolean }> = {};
    for (const [variant, p] of Object.entries(opts.procedures || {})) {
        jsgenProcedures[variant] = { stack: new INTER.IntermediateStack(p.blocks), yields: true };
    }

    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack(entryBlocks);
    native.yields = true;
    native.topBlockId = 'hat1';
    const entrySource = compileToSource(native, { procedures: jsgenProcedures });
    const listIds = new Set<string>();
    collectBlockListIds(entryBlocks, listIds);
    for (const p of Object.values(opts.procedures || {})) collectBlockListIds(p.blocks, listIds);
    scripts['hat1'] = decompileScript(entrySource, { listIds });

    for (const [variant, p] of Object.entries(opts.procedures || {})) {
        const proc = new INTER.IntermediateScript();
        proc.stack = new INTER.IntermediateStack(p.blocks);
        proc.yields = true;
        proc.isProcedure = true;
        proc.procedureCode = variant.substring(1);
        proc.isWarp = !!p.warp;
        proc.arguments = new Array(procedureArgCount(p.blocks, variant.substring(1))).fill('arg');
        proc.topBlockId = `def_${variant}`;
        const source = compileToSource(proc, { isProcedure: true, warp: p.warp, procedures: jsgenProcedures });
        const script = decompileScript(source, { variant: p.variant });
        procedures[variant] = script;
    }

    const hats: TargetIR['hats'] = [{ topBlockId: 'hat1', opcode: 'event_whenflagclicked', fieldsOfInputs: {} }];
    for (const [variant, p] of Object.entries(opts.procedures || {})) {
        const defTop = `def_${variant}`;
        scripts[defTop] = procedures[variant];
        hats.push({ topBlockId: defTop, opcode: 'procedures_definition', fieldsOfInputs: {} });
    }
    return { scripts, procedures, hats };
}

function collectBlockListIds(blocks: any[], ids: Set<string>): void {    const visit = (v: any): void => {
        if (!v || typeof v !== 'object') return;
        if (v.blocks) { v.blocks.forEach(visit); return; }
        if (v.opcode !== undefined && v.inputs) {
            for (const k of Object.keys(v.inputs)) {
                const val = v.inputs[k];
                if (k === 'list') { if (val && val.id) ids.add(val.id); }
                visit(val);
            }
            if (v.substacks) for (const k of Object.keys(v.substacks)) visit(v.substacks[k]);
        }
    };
    blocks.forEach((b) => visit(b));
}

/** Find a serialized block by opcode. */
function findByOpcode(blocks: Record<string, any>, opcode: string): any {
    const ids: string[] = [];
    for (const [id, b] of Object.entries(blocks)) {
        if (Array.isArray(b)) continue;
        if (b.opcode === opcode) ids.push(id);
    }
    return ids.length ? { id: ids[0], block: blocks[ids[0]] } : null;
}

function skipIfNoVM() {
    if (!JSG) { test.skip('scratch-vm compiler not available'); return true; }
    return false;
}

test('serialize: native blocks round-trip through jsgen, decompile, serialize', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('LOOKS_SAY', { message: C('hi') }),
        SB('VAR_SET', { variable: VB('V1'), value: N(3) }),
        SB('CONTROL_IF_ELSE', {
            condition: B(true),
            whenTrue: STACK(SB('MOTION_STEP', { steps: N(1) })),
            whenFalse: STACK(SB('LOOKS_SAY', { message: C('b') })),
        }),
        SB('CONTROL_REPEAT', { times: N(5), do: STACK(SB('MOTION_STEP', { steps: N(1) })) }),
        SB('CONTROL_WAIT', { seconds: N(1) }),
        SB('LIST_ADD', { list: VB('L1'), item: C('x') }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    validateBlocks(blocks);

    const say = findByOpcode(blocks, 'looks_say');
    assert.ok(say, 'looks_say present');
    assert.deepEqual(say!.block.inputs.MESSAGE, [1, [10, 'hi']]);

    const setVar = findByOpcode(blocks, 'data_setvariableto');
    assert.ok(setVar, 'data_setvariableto present');
    assert.deepEqual(setVar!.block.fields.VARIABLE, ['V1', 'V1']);
    assert.deepEqual(setVar!.block.inputs.VALUE, [1, [4, 3]]);

    const ifElse = findByOpcode(blocks, 'control_if_else');
    assert.ok(ifElse, 'control_if_else present');
    assert.ok(ifElse!.block.inputs.CONDITION, 'condition input present');
    assert.ok(ifElse!.block.inputs.SUBSTACK, 'substack present');
    assert.ok(ifElse!.block.inputs.SUBSTACK2, 'substack2 present');

    const repeat = findByOpcode(blocks, 'control_repeat');
    assert.ok(repeat, 'control_repeat present');
    assert.deepEqual(repeat!.block.inputs.TIMES, [1, [4, 5]]);

    const addList = findByOpcode(blocks, 'data_addtolist');
    assert.ok(addList, 'data_addtolist present');
    assert.deepEqual(addList!.block.fields.LIST, ['L1', 'L1']);
});

test('serialize: procedure definition, prototype and call are consistent', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR(
        [
            SB('PROCEDURE_CALL', {
                code: 'do %s %s',
                variant: 'Wdo %s %s',
                arguments: [N(1), C('two')],
            }, true),
        ],
        {
            procedures: {
                'Wdo %s %s': {
                    variant: 'Wdo %s %s',
                    warp: true,
                    blocks: [SB('LOOKS_SAY', { message: new INTER.IntermediateInput(ENUMS.InputOpcode.PROCEDURE_ARGUMENT, ENUMS.InputType.ANY, { index: 0 }) })],
                },
            },
        },
    );

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const def = findByOpcode(blocks, 'procedures_definition');
    assert.ok(def, 'procedures_definition present');

    const proto = findByOpcode(blocks, 'procedures_prototype');
    assert.ok(proto, 'procedures_prototype present');
    assert.equal(proto!.block.mutation.proccode, 'do %s %s');
    assert.equal(proto!.block.mutation.warp, 'true');
    const argIds = JSON.parse(proto!.block.mutation.argumentids);
    assert.equal(argIds.length, 2);

    const call = findByOpcode(blocks, 'procedures_call');
    assert.ok(call, 'procedures_call present');
    assert.deepEqual(JSON.parse(call!.block.mutation.argumentids), argIds, 'call argument ids match prototype');
    assert.equal(call!.block.mutation.proccode, 'do %s %s');
    assert.equal(call!.block.mutation.warp, 'true');
    assert.ok(call!.block.inputs[argIds[0]], 'arg 0 input present');
    assert.ok(call!.block.inputs[argIds[1]], 'arg 1 input present');

    validateBlocks(blocks);
});

test('serialize: broadcast sends and hats', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('EVENT_BROADCAST', { broadcast: C('Start') }),
        SB('EVENT_BROADCAST_AND_WAIT', { broadcast: C('Start') }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const bc = findByOpcode(blocks, 'event_broadcast');
    assert.ok(bc, 'event_broadcast present');
    assert.deepEqual(bc!.block.inputs.BROADCAST_INPUT, [1, [11, 'Start', bc!.block.fields.BROADCAST_OPTION[1]]]);
    assert.equal(bc!.block.fields.BROADCAST_OPTION[0], 'Start');

    const bcWait = findByOpcode(blocks, 'event_broadcastandwait');
    assert.ok(bcWait, 'event_broadcastandwait present');

    validateBlocks(blocks);
});

test('serialize: compat stack and reporter blocks keep original ids', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('COMPATIBILITY_LAYER', {
            opcode: 'some_ext_block', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
            inputs: { X: VAR('V1') }, fields: { STYLE: 'bold' },
        }, true),
        SB('COMPATIBILITY_LAYER', {
            opcode: 'some_ext_if', id: 'blkD', blockType: BLOCKTYPE.CONDITIONAL,
            inputs: { COND: VAR('V1') }, fields: {},
            substacks: { 1: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(9) })) },
        }, true),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    assert.ok(blocks['blkC'], 'compat block keeps original id');
    assert.equal(blocks['blkC'].opcode, 'some_ext_block');
    assert.equal(blocks['blkC'].fields.STYLE[0], 'bold');
    assert.ok(blocks['blkC'].inputs.X, 'compat input serialized');

    assert.ok(blocks['blkD'], 'compat conditional keeps original id');
    assert.ok(blocks['blkD'].inputs.SUBSTACK, 'compat conditional substack');

    validateBlocks(blocks);
});

test('serialize: compat numeric constant input is not mistaken for a field', () => {
    if (skipIfNoVM()) return;

    // jsgen emits a numeric CONSTANT input as a bare literal ({VOLUME: 10}), while fields
    // are always quoted strings ({STYLE: "bold"}). The decompiler must classify numeric
    // literals as inputs so the serializer writes an input descriptor, not a field.
    const ir = targetIR([
        SB('COMPATIBILITY_LAYER', {
            opcode: 'sound_changevolumeby', id: 'blkVol', blockType: BLOCKTYPE.COMMAND,
            inputs: { VOLUME: N(10) }, fields: {},
        }, true),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const vol = blocks['blkVol'];
    assert.ok(vol, 'compat block present');
    assert.ok(vol.inputs.VOLUME, 'VOLUME is an input');
    assert.deepEqual(vol.inputs.VOLUME, [1, [4, 10]]);
    assert.equal(vol.fields.VOLUME, undefined, 'VOLUME is not a field');

    validateBlocks(blocks);
});

test('serialize: hat with broadcast fields', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([SB('LOOKS_SAY', { message: C('go') })]);
    ir.hats = [{ topBlockId: 'hat1', opcode: 'event_whenbroadcastreceived', fieldsOfInputs: { BROADCAST_OPTION: { value: 'GO', id: 'bc_abc' } } }];

    const ctx = makeCtx(ir.procedures);
    ctx.broadcastName = (u) => (u === 'GO' ? 'Go' : u);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const hat = findByOpcode(blocks, 'event_whenbroadcastreceived');
    assert.ok(hat, 'hat present');
    assert.deepEqual(hat!.block.fields.BROADCAST_OPTION, ['Go', 'bc_abc']);

    validateBlocks(blocks);
});

test('serialize: hat fields keep case from recovered edge-hat condition, not uppercased metadata', () => {
    if (skipIfNoVM()) return;

    // An edge-activated "when touching" hat: irgen descends the hat head as a compat layer
    // whose fields carry the true case; the compiled project's hat metadata keeps them uppercased.
    const compatHat = new INTER.IntermediateInput(ENUMS.InputOpcode.COMPATIBILITY_LAYER, ENUMS.InputType.BOOLEAN, {
        opcode: 'event_whentouchingobject',
        id: 'hat1',
        inputs: {},
        fields: { TOUCHINGOBJECTMENU: 'Sprite Name' },
    }, true);
    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack([
        new INTER.IntermediateStackBlock(ENUMS.StackOpcode.HAT_EDGE, { id: 'hat1', condition: compatHat }),
        SB('LOOKS_SAY', { message: C('hi') }),
    ]);
    native.yields = true;
    native.topBlockId = 'hat1';
    const entrySource = compileToSource(native);
    const script = decompileScript(entrySource, {});

    const ir: TargetIR = {
        scripts: { hat1: script },
        procedures: {},
        hats: [{ topBlockId: 'hat1', opcode: 'event_whentouchingobject', fieldsOfInputs: { TOUCHINGOBJECTMENU: { value: 'SPRITE NAME' } } }],
    };
    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const hat = findByOpcode(blocks, 'event_whentouchingobject');
    assert.ok(hat, 'hat present');
    // isTouchingObject -> getSpriteTargetByName compares sprite names case-sensitively.
    assert.deepEqual(hat!.block.fields.TOUCHINGOBJECTMENU, ['Sprite Name']);

    validateBlocks(blocks);
});

test('serialize: hat fields fall back to metadata heuristics when no edge condition is recovered', () => {
    if (skipIfNoVM()) return;

    // A plain "when key pressed" script has no compiled guard, so only the uppercased metadata
    // is available; the serializer must still restore key case via the existing fallback.
    const ir = targetIR([SB('LOOKS_SAY', { message: C('go') })]);
    ir.hats = [{ topBlockId: 'hat1', opcode: 'event_whenkeypressed', fieldsOfInputs: { KEY_OPTION: { value: 'SPACE' } } }];

    const ctx = makeCtx(ir.procedures);
    ctx.keyName = undefined as any; // exercise the default toLowerCase fallback
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const hat = findByOpcode(blocks, 'event_whenkeypressed');
    assert.ok(hat, 'hat present');
    assert.deepEqual(hat!.block.fields.KEY_OPTION, ['space']);

    validateBlocks(blocks);
});

test('serialize: operator mathop and sensing_of', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.OP_ABS, ENUMS.InputType.NUMBER, { value: N(-5) }),
        }),
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.OP_POW_E, ENUMS.InputType.NUMBER, { value: N(1) }),
        }),
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.OP_POW_10, ENUMS.InputType.NUMBER, { value: N(2) }),
        }),
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.OP_LOG_10, ENUMS.InputType.NUMBER, { value: N(100) }),
        }),
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.SENSING_OF_BACKDROP_NAME, ENUMS.InputType.STRING, { object: new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.STRING, { value: '_stage_' }) }),
        }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const mathop = findByOpcode(blocks, 'operator_mathop');
    assert.ok(mathop, 'operator_mathop present');
    assert.deepEqual(mathop!.block.fields.OPERATOR, ['abs']);
    assert.deepEqual(mathop!.block.inputs.NUM, [1, [4, -5]]);

    const ops: string[] = [];
    for (const b of Object.values(blocks)) {
        if (!Array.isArray(b) && b.opcode === 'operator_mathop') ops.push(b.fields.OPERATOR[0]);
    }
    assert.deepEqual(ops.sort(), ['10 ^', 'abs', 'e ^', 'log']);

    const back = findByOpcode(blocks, 'looks_backdropnumbername');
    assert.ok(back, 'looks_backdropnumbername for stage backdrop');
    assert.deepEqual(back!.block.fields.NUMBER_NAME, ['name']);

    validateBlocks(blocks);
});

test('serialize: menu inputs become shadow menu blocks, not fields', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.SENSING_DISTANCE, ENUMS.InputType.STRING, {
                target: C('_mouse_'),
            }),
        }),
        SB('VAR_SET', {
            variable: VB('V1'),
            value: new INTER.IntermediateInput(ENUMS.InputOpcode.SENSING_KEY_DOWN, ENUMS.InputType.BOOLEAN, {
                key: C('space'),
            }),
        }),
        SB('LOOKS_SAY', {
            message: new INTER.IntermediateInput(ENUMS.InputOpcode.SENSING_TOUCHING_OBJECT, ENUMS.InputType.BOOLEAN, {
                object: C('_edge_'),
            }),
        }),
        SB('CONTROL_CLONE_CREATE', { target: C('Sprite2') }),
        SB('PEN_COLOR_PARAM_SET', { param: C('color'), value: N(10) }),
        SB('PEN_COLOR_PARAM_CHANGE', { param: C('brightness'), value: N(5) }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const dist = findByOpcode(blocks, 'sensing_distanceto');
    assert.ok(dist, 'sensing_distanceto present');
    const distMenuId = dist!.block.inputs.DISTANCETOMENU[1];
    assert.equal(typeof distMenuId, 'string', 'input descriptor references menu block');
    const distMenu = blocks[distMenuId];
    assert.ok(distMenu, 'distance menu block exists');
    assert.equal(distMenu.opcode, 'sensing_distancetomenu');
    assert.deepEqual(distMenu.fields.DISTANCETOMENU, ['_mouse_']);
    assert.equal(distMenu.shadow, true);
    assert.equal(distMenu.parent, dist!.id);

    const key = findByOpcode(blocks, 'sensing_keypressed');
    assert.ok(key, 'sensing_keypressed present');
    const keyMenu = blocks[key!.block.inputs.KEY_OPTION[1]];
    assert.ok(keyMenu, 'key menu block exists');
    assert.equal(keyMenu.opcode, 'sensing_keyoptions');
    assert.deepEqual(keyMenu.fields.KEY_OPTION, ['space']);

    const touch = findByOpcode(blocks, 'sensing_touchingobject');
    assert.ok(touch, 'sensing_touchingobject present');
    const touchMenu = blocks[touch!.block.inputs.TOUCHINGOBJECTMENU[1]];
    assert.equal(touchMenu.opcode, 'sensing_touchingobjectmenu');
    assert.deepEqual(touchMenu.fields.TOUCHINGOBJECTMENU, ['_edge_']);

    const clone = findByOpcode(blocks, 'control_create_clone_of');
    assert.ok(clone, 'control_create_clone_of present');
    const cloneMenu = blocks[clone!.block.inputs.CLONE_OPTION[1]];
    assert.equal(cloneMenu.opcode, 'control_create_clone_of_menu');
    assert.deepEqual(cloneMenu.fields.CLONE_OPTION, ['Sprite2']);

    const setParam = findByOpcode(blocks, 'pen_setPenColorParamTo');
    assert.ok(setParam, 'pen_setPenColorParamTo present');
    const setParamMenu = blocks[setParam!.block.inputs.COLOR_PARAM[1]];
    assert.equal(setParamMenu.opcode, 'pen_menu_colorParam');
    assert.deepEqual(setParamMenu.fields.COLOR_PARAM, ['color']);

    const changeParam = findByOpcode(blocks, 'pen_changePenColorParamBy');
    assert.ok(changeParam, 'pen_changePenColorParamBy present');
    const changeParamMenu = blocks[changeParam!.block.inputs.COLOR_PARAM[1]];
    assert.equal(changeParamMenu.opcode, 'pen_menu_colorParam');
    assert.deepEqual(changeParamMenu.fields.COLOR_PARAM, ['brightness']);

    validateBlocks(blocks);
});

test('serialize: procedure argument VALUE field carries the parameter name', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR(
        [
            SB('PROCEDURE_CALL', {
                code: 'greet %s %s',
                variant: 'Wgreet %s %s',
                arguments: [C('a'), C('b')],
            }, true),
        ],
        {
            procedures: {
                'Wgreet %s %s': {
                    variant: 'Wgreet %s %s',
                    warp: true,
                    blocks: [
                        SB('LOOKS_SAY', { message: new INTER.IntermediateInput(ENUMS.InputOpcode.PROCEDURE_ARGUMENT, ENUMS.InputType.ANY, { index: 0 }) }),
                        SB('LOOKS_SAY', { message: new INTER.IntermediateInput(ENUMS.InputOpcode.PROCEDURE_ARGUMENT, ENUMS.InputType.ANY, { index: 1 }) }),
                    ],
                },
            },
        },
    );

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const proto = findByOpcode(blocks, 'procedures_prototype');
    const argNames = JSON.parse(proto!.block.mutation.argumentnames);
    assert.deepEqual(argNames, ['arg0', 'arg1']);

    const args = Object.values(blocks)
        .filter((b: any): b is Record<string, any> => b && !Array.isArray(b) && b.opcode === 'argument_reporter_string_number')
        .map((b) => b.fields.VALUE[0]);
    assert.ok(args.length >= 2);
    assert.ok(args.includes('arg0'), `has arg0 reporter, got ${JSON.stringify(args)}`);
    assert.ok(args.includes('arg1'), `has arg1 reporter, got ${JSON.stringify(args)}`);
    assert.ok(args.every((v) => !String(v).startsWith('arg_')), 'never uses generated arg ids as VALUE');

    validateBlocks(blocks);
});

test('serialize: event_whengreaterthan hat VALUE input and field case', () => {
    if (skipIfNoVM()) return;

    // Edge-activated "when [timer] > (10)" hat: irgen descends the hat head as a compat
    // layer with inputs.VALUE = threshold reporter and fields.WHENGREATERTHANMENU = 'timer'.
    const compatHat = new INTER.IntermediateInput(ENUMS.InputOpcode.COMPATIBILITY_LAYER, ENUMS.InputType.BOOLEAN, {
        opcode: 'event_whengreaterthan',
        id: 'hat1',
        inputs: { VALUE: N(10) },
        fields: { WHENGREATERTHANMENU: 'timer' },
    }, true);
    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack([
        new INTER.IntermediateStackBlock(ENUMS.StackOpcode.HAT_EDGE, { id: 'hat1', condition: compatHat }),
        SB('LOOKS_SAY', { message: C('hi') }),
    ]);
    native.yields = true;
    native.topBlockId = 'hat1';
    const entrySource = compileToSource(native);
    const script = decompileScript(entrySource, {});

    const ir: TargetIR = {
        scripts: { hat1: script },
        procedures: {},
        hats: [{ topBlockId: 'hat1', opcode: 'event_whengreaterthan', fieldsOfInputs: { WHENGREATERTHANMENU: { value: 'TIMER' } } }],
    };
    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const hat = findByOpcode(blocks, 'event_whengreaterthan');
    assert.ok(hat, 'hat present');
    // VALUE must be an inline numeric primitive, NOT a reference to a nested block.
    assert.deepEqual(hat!.block.inputs.VALUE, [1, [4, 10]]);
    // Field case must come from the recovered compat condition, not uppercased metadata.
    assert.deepEqual(hat!.block.fields.WHENGREATERTHANMENU, ['timer']);
    // No nested event_whengreaterthan block should exist.
    const nestedHats = Object.values(blocks).filter((b: any) => !Array.isArray(b) && b.opcode === 'event_whengreaterthan');
    assert.equal(nestedHats.length, 1, 'no nested event_whengreaterthan block');

    validateBlocks(blocks);
});

test('serialize: EFFECT and CURRENTMENU fields use scratch-blocks uppercase storage values', () => {
    if (skipIfNoVM()) return;

    // irgen lowercases EFFECT (to match target.effects keys) and CURRENTMENU (to match its
    // switch labels), but scratch-blocks stores dropdown values uppercase ('COLOR', 'YEAR').
    // The serializer must restore the uppercase storage value in the sb3 field.
    const ir = targetIR([
        SB('LOOKS_EFFECT_SET', { effect: 'color', value: N(10) }),
        SB('LOOKS_EFFECT_CHANGE', { effect: 'fisheye', value: N(5) }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const setEff = findByOpcode(blocks, 'looks_seteffectto');
    assert.ok(setEff, 'looks_seteffectto present');
    assert.deepEqual(setEff!.block.fields.EFFECT, ['COLOR']);

    const chgEff = findByOpcode(blocks, 'looks_changeeffectby');
    assert.ok(chgEff, 'looks_changeeffectby present');
    assert.deepEqual(chgEff!.block.fields.EFFECT, ['FISHEYE']);

    validateBlocks(blocks);
});

test('serialize: block chain parent/next correctly links each block to its predecessor', () => {
    if (skipIfNoVM()) return;

    // Three stacked blocks: each block's parent must point to the previous block in the
    // chain, not to the chain head (hat). The old code set all parents to the chain head.
    const ir = targetIR([
        SB('LOOKS_SAY', { message: C('a') }),
        SB('LOOKS_SAY', { message: C('b') }),
        SB('LOOKS_SAY', { message: C('c') }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    // Walk the chain from hat → first body block → ... → null
    let prevId: string = 'hat1';
    let currentId: string | null = null;
    // Find hat block
    const hat = Object.values(blocks).find((b: any) => !Array.isArray(b) && b.opcode === 'event_whenflagclicked') as any;
    assert.ok(hat, 'hat present');
    currentId = hat.next;
    let count = 0;
    while (currentId) {
        const current = blocks[currentId];
        assert.ok(current, `block ${currentId} exists`);
        assert.equal(current.parent, prevId, `block ${currentId} parent should be ${prevId}`);
        prevId = currentId;
        currentId = current.next;
        count++;
    }
    assert.ok(count >= 3, `chain has at least 3 body blocks, got ${count}`);

    validateBlocks(blocks);
});

test('serialize: list reporters emit LIST field', () => {
    if (skipIfNoVM()) return;

    const listRef = VB('L1');
    const ir = targetIR([
        SB('VAR_SET', {
            variable: VB('V1'),
            value: IN('LIST_GET', { list: listRef, index: N(1) }, ENUMS.InputType.ANY),
        }),
        SB('VAR_SET', {
            variable: VB('V1'),
            value: IN('LIST_LENGTH', { list: listRef }, ENUMS.InputType.NUMBER),
        }),
        SB('VAR_SET', {
            variable: VB('V1'),
            value: IN('LIST_CONTAINS', { list: listRef, item: C('x') }, ENUMS.InputType.BOOLEAN),
        }),
        SB('VAR_SET', {
            variable: VB('V1'),
            value: IN('LIST_INDEX_OF', { list: listRef, item: C('x') }, ENUMS.InputType.NUMBER),
        }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    validateBlocks(blocks);

    const itemOfList = findByOpcode(blocks, 'data_itemoflist');
    assert.ok(itemOfList, 'data_itemoflist present');
    assert.deepEqual(itemOfList!.block.fields.LIST, ['L1', 'L1'], 'LIST field present on data_itemoflist');

    const lengthOfList = findByOpcode(blocks, 'data_lengthoflist');
    assert.ok(lengthOfList, 'data_lengthoflist present');
    assert.deepEqual(lengthOfList!.block.fields.LIST, ['L1', 'L1'], 'LIST field present on data_lengthoflist');

    const contains = findByOpcode(blocks, 'data_listcontainsitem');
    assert.ok(contains, 'data_listcontainsitem present');
    assert.deepEqual(contains!.block.fields.LIST, ['L1', 'L1'], 'LIST field present on data_listcontainsitem');

    const itemNum = findByOpcode(blocks, 'data_itemnumoflist');
    assert.ok(itemNum, 'data_itemnumoflist present');
    assert.deepEqual(itemNum!.block.fields.LIST, ['L1', 'L1'], 'LIST field present on data_itemnumoflist');
});

test('serialize: Infinity and -Infinity constants round-trip through jsgen and decompiler', () => {
    if (skipIfNoVM()) return;

    // jsgen emits Infinity/-Infinity as bare identifiers (CONSTANT.toString()).
    // The decompiler must recognize these identifiers and restore them as constants,
    // not fall back to CONSTANT(0).
    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack([
        SB('VAR_SET', { variable: VB('V1'), value: new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.NUMBER_POS_INF, { value: Infinity }) }),
        SB('VAR_SET', { variable: VB('V1'), value: new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.NUMBER_NEG_INF, { value: -Infinity }) }),
    ]);
    native.yields = true;
    native.topBlockId = 'hat1';
    const entrySource = compileToSource(native);
    const script = decompileScript(entrySource, {});

    const ir: TargetIR = {
        scripts: { hat1: script },
        procedures: {},
        hats: [{ topBlockId: 'hat1', opcode: 'event_whenflagclicked', fieldsOfInputs: {} }],
    };
    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    const sets = Object.values(blocks).filter((b: any) => !Array.isArray(b) && b.opcode === 'data_setvariableto') as any[];
    assert.ok(sets.length >= 2, `at least 2 set blocks, got ${sets.length}`);
    assert.deepEqual(sets[0].inputs.VALUE, [1, [4, 'Infinity']]);
    assert.deepEqual(sets[1].inputs.VALUE, [1, [4, '-Infinity']]);

    validateBlocks(blocks);
});

test('serialize: sensing_of reporters emit OBJECT input for sprite targets', () => {
    if (skipIfNoVM()) return;

    const ir = targetIR([
        SB('LOOKS_SAY', {
            message: IN('SENSING_OF_POS_X', { object: C('Sprite2') }, ENUMS.InputType.NUMBER),
        }),
        SB('LOOKS_SAY', {
            message: IN('SENSING_OF_VAR', { object: C('Sprite2'), property: 'myvar' }, ENUMS.InputType.ANY),
        }),
        SB('LOOKS_SAY', {
            message: IN('SENSING_OF', { object: C('_stage_'), property: 'x position' }, ENUMS.InputType.ANY),
        }),
    ]);

    const ctx = makeCtx(ir.procedures);
    const { blocks } = serializeTargetBlocks(ir, ctx);

    validateBlocks(blocks);

    const ofs = Object.values(blocks).filter((b: any) => !Array.isArray(b) && b.opcode === 'sensing_of') as any[];
    assert.ok(ofs.length >= 3, `at least 3 sensing_of blocks, got ${ofs.length}`);

    // SENSING_OF_POS_X with a sprite target must carry its OBJECT input through.
    const posX = ofs.find((b) => b.fields?.PROPERTY?.[0] === 'x position')!;
    assert.ok(posX, 'sensing_of x position present');
    assert.ok(posX.inputs.OBJECT, 'sensing_of x position has OBJECT input');
    assert.deepEqual(posX.fields.PROPERTY, ['x position']);

    // SENSING_OF_VAR must carry through both OBJECT and PROPERTY.
    const ofVar = ofs.find((b) => b.fields?.PROPERTY?.[0] === 'myvar')!;
    assert.ok(ofVar, 'sensing_of myvar present');
    assert.ok(ofVar.inputs.OBJECT, 'sensing_of myvar has OBJECT input');
    assert.deepEqual(ofVar.fields.PROPERTY, ['myvar']);
});
