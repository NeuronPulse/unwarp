import type { Node } from 'estree';
import { parseFactorySource } from './parser';
import { compileBlock } from './statement';
import { IntermediateScript, IntermediateStack, IntermediateRepresentation, StackOpcode } from './ir';
import { DecompileContext, newObservations } from './types';

export * from './ir';
export * from './types';
export { parseFactorySource } from './parser';
export { compileExpr } from './expression';
export { compileBlock, compileStatements } from './statement';

/** Warp is encoded in a procedure variant's first character: `W` = warp, `Z` = not. */
export function parseIsWarp(variant: string): boolean {
    return variant.charAt(0) === 'W';
}

/** Strip the warp marker off a procedure variant to get the Scratch proccode. */
export function parseProcedureCode(variant: string): string {
    return variant.substring(1);
}

function containsYield(node: Node): boolean {
    let found = false;
    const walk = (n: any): void => {
        if (!n || found || typeof n !== 'object') return;
        if (n.type === 'YieldExpression') {
            found = true;
            return;
        }
        for (const k of Object.keys(n)) {
            const v = n[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(node);
    return found;
}

export interface DecompileOptions {
    /**
     * The procedure variant this source implements (e.g. `Zmove %s steps`). Supplying it
     * marks the script as a procedure and recovers isWarp / procedureCode exactly, since
     * the variant string itself encodes them.
     */
    variant?: string;
    /**
     * ids that name a list rather than a scalar variable. Needed because jsgen emits
     * byte-identical JS for LIST_SHOW/HIDE and VAR_SHOW/HIDE; without it the monitor-toggle
     * recognizer cannot tell them apart. Normally populated from a target's declared lists.
     */
    listIds?: Set<string>;
}

/** Decompile one script factory-source string into an IntermediateScript. */
export function decompileScript(source: string, options: DecompileOptions = {}): IntermediateScript {
    const parsed = parseFactorySource(source);
    const observed = newObservations();
    const ctx: DecompileContext = {
        setupConsts: parsed.setupConsts,
        params: parsed.params,
        targetVar: parsed.targetVar,
        runtimeVar: parsed.runtimeVar,
        stageVar: parsed.stageVar,
        threadParam: parsed.threadParam,
        listIds: options.listIds,
        observed,
    };

    const script = new IntermediateScript();
    script.stack = compileBlock(parsed.body, ctx, true);

    // jsgen emits `function*` exactly when script.yields, so generator-ness is authoritative.
    script.yields = parsed.isGenerator || containsYield(parsed.body);
    script.warpTimer = observed.stuckYield;
    script.executableHat = observed.executableHat;
    script.dependedProcedures = observed.calls;
    script.topBlockId = observed.topBlockId;
    // Argument *names* are not present in compiled JS -- only the count, as p0..pN.
    script.arguments = parsed.params.map((_, i) => `arg${i}`);

    if (options.variant) {
        script.isProcedure = true;
        script.procedureVariant = options.variant;
        script.procedureCode = parseProcedureCode(options.variant);
        script.isWarp = parseIsWarp(options.variant);
    }

    return script;
}

export interface LinkResult {
    ir: IntermediateRepresentation;
    /** Variants that were called but whose source was not supplied; stubbed in the IR. */
    missing: string[];
}

/**
 * Decompile an entry script plus a pool of procedure sources, following procedure calls
 * transitively so only reachable procedures end up in the IR.
 *
 * Any called variant with no supplied source becomes an empty stub rather than an error,
 * so a partial dump still yields usable IR; those variants are listed in `missing`.
 */
export function linkSources(entrySource: string, procedureSources: Record<string, string> = {}): LinkResult {
    const entry = decompileScript(entrySource);
    const procedures: Record<string, IntermediateScript> = {};
    const missing: string[] = [];

    const queue = [...entry.dependedProcedures];
    while (queue.length) {
        const variant = queue.shift()!;
        if (Object.prototype.hasOwnProperty.call(procedures, variant)) continue;

        const source = procedureSources[variant];
        if (source === undefined) {
            const stub = new IntermediateScript();
            stub.isProcedure = true;
            stub.procedureVariant = variant;
            stub.procedureCode = parseProcedureCode(variant);
            stub.isWarp = parseIsWarp(variant);
            stub.stack = new IntermediateStack();
            stub.yields = false;
            procedures[variant] = stub;
            missing.push(variant);
            continue;
        }

        const script = decompileScript(source, { variant });
        procedures[variant] = script;
        queue.push(...script.dependedProcedures);
    }

    const ir = new IntermediateRepresentation(entry, procedures);
    propagateYields(ir);
    return { ir, missing };
}

/**
 * jsgen refuses to compile a script that calls a yielding procedure without being marked
 * as yielding itself. Generator-ness already tells us this for every script we saw, but a
 * stubbed or hand-edited procedure can break the invariant, so close it to a fixpoint and
 * sync each PROCEDURE_CALL block's yields flag with its callee.
 */
function propagateYields(ir: IntermediateRepresentation): void {
    const all = [ir.entry, ...Object.values(ir.procedures)];
    let changed = true;
    while (changed) {
        changed = false;
        for (const script of all) {
            if (!script.stack) continue;
            for (const call of eachProcedureCall(script.stack)) {
                const callee = ir.procedures[call.inputs.variant];
                if (!callee) continue;
                if (call.yields !== callee.yields) {
                    call.yields = callee.yields;
                    changed = true;
                }
                if (callee.yields && !script.yields) {
                    script.yields = true;
                    changed = true;
                }
            }
        }
    }
}

/** Walk every PROCEDURE_CALL block in a stack, including nested substacks. */
function* eachProcedureCall(stack: IntermediateStack): Generator<any> {
    for (const block of stack.blocks) {
        if (block.opcode === StackOpcode.PROCEDURE_CALL) yield block;
        for (const input of Object.values(block.inputs)) {
            if (input instanceof IntermediateStack) yield* eachProcedureCall(input);
        }
    }
}

/** Decompile an entry script plus a set of procedure variant sources. */
export function decompileSources(
    entrySource: string,
    procedureSources: Record<string, string> = {},
): IntermediateRepresentation {
    return linkSources(entrySource, procedureSources).ir;
}
