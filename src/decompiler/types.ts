import type { Node } from 'estree';

/** A variable/list reference recovered from the compiled JS. */
export interface DescendedVariable {
    scope: 'target' | 'stage';
    id: string;
    name: string;
    isCloud: boolean;
}

/** Context threaded through the expression/statement decompilers. */
export interface DecompileContext {
    /** name of a hoisted const (jsgen's evaluateOnce) -> its source AST node. */
    setupConsts: Map<string, Node>;
    /** parameter names of the inner function, e.g. ['p0', 'p1']. */
    params: string[];
    /** identifier used for the target (usually 'target'). */
    targetVar: string;
    /** identifier used for the stage (usually 'stage'). */
    stageVar: string;
    /** identifier used for the runtime (usually 'runtime'); obfuscated code renames it. */
    runtimeVar: string;
    /** name of the factory's own thread parameter (usually 'thread'); obfuscated code renames it. */
    threadParam: string;
    /**
     * ids known to name a *list* rather than a scalar variable. jsgen emits byte-identical
     * JS for LIST_SHOW/HIDE and VAR_SHOW/HIDE, so the monitor-toggle recognizer consults this
     * to tell them apart. Absent or missing ids fall back to the VAR_* form.
     */
    listIds?: Set<string>;
    /** Observations collected while walking the body; used to reconstruct script flags. */
    observed?: Observations;
}

/**
 * Facts about a script that are only visible in *how* jsgen emitted it, not in the
 * blocks themselves. Collected as a side effect of decompiling and folded back into
 * the IntermediateScript afterwards.
 */
export interface Observations {
    /** Saw `if (isStuck()) yield;` -- jsgen only emits this inside a warp script. */
    stuckYield: boolean;
    /** Saw a HAT_EDGE / HAT_PREDICATE block, which implies script.executableHat. */
    executableHat: boolean;
    /** Procedure variants this script calls, in encounter order. */
    calls: string[];
    /** Recovered from a visualReport call, the only place jsgen emits the top block id. */
    topBlockId: string | null;
}

export function newObservations(): Observations {
    return { stuckYield: false, executableHat: false, calls: [], topBlockId: null };
}

export class DecompileError extends Error {
    constructor(message: string) {
        super(`unwarp: ${message}`);
        this.name = 'DecompileError';
    }
}

/** Loose AST node alias (acorn's output, no strict typing needed here). */
export type ASTNode = any;
