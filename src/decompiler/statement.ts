import type { Node } from 'estree';
import {
    IntermediateInput, IntermediateStackBlock, IntermediateStack,
    StackOpcode, InputOpcode, InputType,
} from './ir';
import { DecompileContext, DescendedVariable, ASTNode } from './types';
import { compileExpr, resolveVarRef, sameVar, makeConstant, opcodeOfCompatFn, parseCompatArgs } from './expression';

// ---------------------------------------------------------------------------
// AST shape helpers
// ---------------------------------------------------------------------------

function idName(p: Node | null | undefined): string | null {
    if (!p) return null;
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
    return null;
}

/** Flatten a non-computed member chain (`a.b.c`) into `"a.b.c"`. */
function dottedPath(node: Node | null | undefined): string | null {
    const n = node as ASTNode;
    if (!n) return null;
    if (n.type === 'Identifier') return n.name;
    if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
        const base = dottedPath(n.object);
        return base === null ? null : `${base}.${n.property.name}`;
    }
    return null;
}

/**
 * Like dottedPath, but rewrites the root identifier to the canonical `target` / `stage`
 * names jsgen uses, so recognizers can be written against fixed strings even if the
 * factory renamed them.
 */
function pathOf(node: Node | null | undefined, ctx: DecompileContext): string | null {
    const raw = dottedPath(node);
    if (raw === null) return null;
    const dot = raw.indexOf('.');
    const root = dot === -1 ? raw : raw.slice(0, dot);
    const rest = dot === -1 ? '' : raw.slice(dot);
    if (root === ctx.targetVar) return `target${rest}`;
    if (root === ctx.stageVar) return `stage${rest}`;
    if (root === ctx.runtimeVar) return `runtime${rest}`;
    if (root === ctx.threadParam) return `thread${rest}`;
    return raw;
}

function isPath(node: Node | null | undefined, ctx: DecompileContext, path: string): boolean {
    return pathOf(node, ctx) === path;
}

function litStr(node: Node | null | undefined): string | null {
    const n = node as ASTNode;
    return n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null;
}

function litBool(node: Node | null | undefined): boolean | null {
    const n = node as ASTNode;
    return n && n.type === 'Literal' && typeof n.value === 'boolean' ? n.value : null;
}

function isLit(node: Node | null | undefined, value: unknown): boolean {
    const n = node as ASTNode;
    return !!n && n.type === 'Literal' && n.value === value;
}

/** If `node` is `<path> + X`, return X. Used for the "change by" shapes. */
function addendOver(node: Node | null | undefined, ctx: DecompileContext, path: string): Node | null {
    const n = node as ASTNode;
    if (!n || n.type !== 'BinaryExpression' || n.operator !== '+') return null;
    if (isPath(n.left, ctx, path)) return n.right;
    if (isPath(n.right, ctx, path)) return n.left;
    return null;
}

/** Statements of a body, whether or not it is wrapped in a block. */
function bodyOf(node: Node): Node[] {
    const n = node as ASTNode;
    return n.type === 'BlockStatement' ? n.body : [n];
}

/**
 * javascript-obfuscator collapses a block's statements into one comma-sequence
 * (`i++, ref.value = i, body...;`). Expand such statements into individual
 * pseudo-statements so pattern matchers see them as separate statements.
 */
function expandSequenceBody(bodyStmts: Node[]): Node[] {
    const out: Node[] = [];
    for (const s of bodyStmts) {
        const n = s as ASTNode;
        if (n.type === 'ExpressionStatement' && n.expression.type === 'SequenceExpression') {
            for (const part of n.expression.expressions) {
                const stmt: ASTNode = { type: 'ExpressionStatement', expression: part, start: part.start, end: part.end };
                out.push(stmt);
            }
        } else {
            out.push(s);
        }
    }
    return out;
}

/** Unwrap a statement (or single-statement block) that is just one call. */
function soleCall(node: Node | null | undefined): ASTNode | null {
    if (!node) return null;
    const stmts = bodyOf(node);
    if (stmts.length !== 1) return null;
    const s = stmts[0] as ASTNode;
    if (s.type !== 'ExpressionStatement' || s.expression.type !== 'CallExpression') return null;
    return s.expression;
}

function isBareCall(node: Node | null | undefined, name: string): boolean {
    const n = node as ASTNode;
    if (!n || n.type !== 'ExpressionStatement') return false;
    const e = n.expression as ASTNode;
    return e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === name;
}

// ---------------------------------------------------------------------------
// Noise: statements jsgen emits for bookkeeping that carry no IR block
// ---------------------------------------------------------------------------

/**
 * `if (isStuck()) yield;` -- jsgen's yieldStuckOrNotWarp() in a warp script.
 * As a *loop tail* it means the script has a warp timer; after a wait-until it is
 * emitted unconditionally, so callers must only read it in loop position.
 */
function isStuckYield(node: Node): boolean {
    const n = node as ASTNode;
    if (n.type !== 'IfStatement') return false;
    const t = n.test as ASTNode;
    return t.type === 'CallExpression' && t.callee.type === 'Identifier' && t.callee.name === 'isStuck';
}

function isNoise(node: Node, ctx: DecompileContext): boolean {
    const n = node as ASTNode;
    if (n.type === 'EmptyStatement') return true;
    // javascript-obfuscator's string-array decoder helpers sometimes land inside the
    // generator body (between real statements); they carry no IR block.
    if (n.type === 'FunctionDeclaration') return true;
    if (isStuckYield(node)) {
        // jsgen emits `if (isStuck()) yield;` only inside a warp script, so seeing it anywhere
        // (a wait tail, a loop tail, a compat loop) proves the whole script has a warp timer.
        if (ctx.observed) ctx.observed.stuckYield = true;
        return true;
    }

    if (n.type === 'ExpressionStatement') {
        const e = n.expression as ASTNode;
        // bare `yield;` / `yield*` scheduling points
        if (e.type === 'YieldExpression' && !e.argument) return true;
        if (e.type === 'AssignmentExpression') {
            // `<list>._monitorUpToDate = false;` trails every list mutation
            if (idName(e.left.property) === '_monitorUpToDate') return true;
            // `thread.timer = null;` closes out a control.wait
            if (isPath(e.left, ctx, 'thread.timer') && isLit(e.right, null)) return true;
        }
        if (e.type === 'CallExpression') {
            const p = pathOf(e.callee, ctx);
            if (p === 'runtime.ext_scratch3_looks._renderBubble') return true;
            if (p === 'runtime.requestRedraw') return true;
        }
    }

    // `if (target.interpolationData) target.interpolationData = null;` trails setXY
    if (n.type === 'IfStatement' && isPath(n.test, ctx, 'target.interpolationData')) return true;

    // jsgen's compat-layer resume tail, emitted after a compat command that is the last
    // block in a loop body: `if (hasResumedFromPromise) {hasResumedFromPromise = false;continue;}`
    // `hasResumedFromPromise` is an internal jsgen variable -- Scratch variables are always
    // referenced as `target.variables["id"]` -- so this can never be a real block.
    if (n.type === 'IfStatement' && isPath(n.test, ctx, 'hasResumedFromPromise')) {
        const cons = bodyOf(n.consequent);
        const assign = cons[0] as ASTNode;
        const cont = cons[1] as ASTNode;
        if (assign?.type === 'ExpressionStatement' && assign.expression.type === 'AssignmentExpression' &&
            isPath(assign.expression.left, ctx, 'hasResumedFromPromise') &&
            isLit(assign.expression.right, false) &&
            cont?.type === 'ContinueStatement') {
            return true;
        }
    }

    return false;
}

/**
 * jsgen's retire() emits `retire(); return;` (scripts) or `retire(); yield;` (procedures).
 * Returns how many statements starting at `i` that pair occupies, or 0 if `i` is not a retire.
 */
function retireRun(stmts: Node[], i: number): number {
    if (!isBareCall(stmts[i], 'retire')) return 0;
    // the obfuscator may hoist a dead helper-function declaration between `retire()` and
    // its `return;` / `yield;` tail; skip it (it produces no blocks)
    let j = i + 1;
    while (j < stmts.length && stmts[j].type === 'FunctionDeclaration') j++;
    const next = stmts[j] as ASTNode;
    if (next && next.type === 'ReturnStatement' && !next.argument) return j - i + 1;
    if (next && next.type === 'ExpressionStatement' && next.expression.type === 'YieldExpression' &&
        !next.expression.argument) return j - i + 1;
    return 1;
}

// ---------------------------------------------------------------------------
// Simple call tables
// ---------------------------------------------------------------------------

const NO_ARG_CALLS: Record<string, string> = {
    'target.clearEffects': StackOpcode.LOOKS_EFFECT_CLEAR,
    'target.goToBack': StackOpcode.LOOKS_LAYER_BACK,
    'target.goToFront': StackOpcode.LOOKS_LAYER_FRONT,
    'runtime.ext_scratch3_motion._ifOnEdgeBounce': StackOpcode.MOTION_IF_ON_EDGE_BOUNCE,
    'runtime.ioDevices.clock.resetProjectTimer': StackOpcode.SENSING_TIMER_RESET,
    'runtime.ext_pen.clear': StackOpcode.PEN_CLEAR,
    'runtime.ext_pen._penDown': StackOpcode.PEN_DOWN,
    'runtime.ext_pen._penUp': StackOpcode.PEN_UP,
    'runtime.ext_pen._stamp': StackOpcode.PEN_STAMP,
    'runtime.stopForTarget': StackOpcode.CONTROL_STOP_OTHERS,
};

/** path -> [opcode, IR input name, index of the meaningful argument] */
const ONE_ARG_CALLS: Record<string, [string, string, number]> = {
    'target.goBackwardLayers': [StackOpcode.LOOKS_LAYER_BACKWARD, 'layers', 0],
    'target.goForwardLayers': [StackOpcode.LOOKS_LAYER_FORWARD, 'layers', 0],
    'target.setDirection': [StackOpcode.MOTION_DIRECTION_SET, 'direction', 0],
    'runtime.ext_scratch3_motion._moveSteps': [StackOpcode.MOTION_STEP, 'steps', 0],
    'runtime.ext_scratch3_looks._say': [StackOpcode.LOOKS_SAY, 'message', 0],
    'runtime.ext_scratch3_looks._think': [StackOpcode.LOOKS_THINK, 'message', 0],
    'runtime.ext_scratch3_looks._setCostume': [StackOpcode.LOOKS_COSTUME_SET, 'costume', 1],
    'runtime.ext_scratch3_control._createClone': [StackOpcode.CONTROL_CLONE_CREATE, 'target', 0],
    'runtime.ext_pen._changePenSizeBy': [StackOpcode.PEN_SIZE_CHANGE, 'size', 0],
    'runtime.ext_pen._setPenSizeTo': [StackOpcode.PEN_SIZE_SET, 'size', 0],
    'runtime.ext_pen._changePenHueBy': [StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY, 'hue', 0],
    'runtime.ext_pen._setPenHueToNumber': [StackOpcode.PEN_COLOR_HUE_SET_LEGACY, 'hue', 0],
    'runtime.ext_pen._changePenShadeBy': [StackOpcode.PEN_COLOR_SHADE_CHANGE_LEGACY, 'shade', 0],
    'runtime.ext_pen._setPenShadeToNumber': [StackOpcode.PEN_COLOR_SHADE_SET_LEGACY, 'shade', 0],
    'runtime.ext_pen._setPenColorToColor': [StackOpcode.PEN_COLOR_SET, 'color', 0],
};

// ---------------------------------------------------------------------------
// Call-statement recognizers
// ---------------------------------------------------------------------------

function block(opcode: string, inputs: Record<string, any> = {}, yields = false): IntermediateStackBlock[] {
    return [new IntermediateStackBlock(opcode, inputs, yields)];
}

/** `target.setEffect("eff", runtime.ext_scratch3_looks.clampEffect("eff", V))` */
function matchSetEffect(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const effect = litStr(n.arguments[0]);
    if (effect === null) return null;
    const clamp = n.arguments[1] as ASTNode;
    if (!clamp || clamp.type !== 'CallExpression' ||
        pathOf(clamp.callee, ctx) !== 'runtime.ext_scratch3_looks.clampEffect') return null;
    const value = clamp.arguments[1];
    if (!value) return null;
    // change-by folds the current effect value into the operand
    const delta = matchEffectDelta(value, ctx, effect);
    if (delta) return block(StackOpcode.LOOKS_EFFECT_CHANGE, { effect, value: compileExpr(delta, ctx) });
    return block(StackOpcode.LOOKS_EFFECT_SET, { effect, value: compileExpr(value, ctx) });
}

/** `V + target.effects["eff"]` -> V */
function matchEffectDelta(node: Node, ctx: DecompileContext, effect: string): Node | null {
    const n = node as ASTNode;
    if (n.type !== 'BinaryExpression' || n.operator !== '+') return null;
    const isEffectRead = (side: Node): boolean => {
        const s = side as ASTNode;
        return s.type === 'MemberExpression' && s.computed && litStr(s.property) === effect &&
            isPath(s.object, ctx, 'target.effects');
    };
    if (isEffectRead(n.right)) return n.left;
    if (isEffectRead(n.left)) return n.right;
    return null;
}

/** `target.setXY(...)` covers five different motion blocks depending on argument shape. */
function matchSetXY(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const [ax, ay] = n.arguments;
    if (!ax || !ay) return null;
    const xIsCurrent = isPath(ax, ctx, 'target.x');
    const yIsCurrent = isPath(ay, ctx, 'target.y');

    const dx = addendOver(ax, ctx, 'target.x');
    if (dx && yIsCurrent) return block(StackOpcode.MOTION_X_CHANGE, { dx: compileExpr(dx, ctx) });
    const dy = addendOver(ay, ctx, 'target.y');
    if (dy && xIsCurrent) return block(StackOpcode.MOTION_Y_CHANGE, { dy: compileExpr(dy, ctx) });

    if (yIsCurrent && !xIsCurrent) return block(StackOpcode.MOTION_X_SET, { x: compileExpr(ax, ctx) });
    if (xIsCurrent && !yIsCurrent) return block(StackOpcode.MOTION_Y_SET, { y: compileExpr(ay, ctx) });
    return block(StackOpcode.MOTION_XY_SET, { x: compileExpr(ax, ctx), y: compileExpr(ay, ctx) });
}

/**
 * `runtime.monitorBlocks.changeBlock({ id, element: "checkbox", value }, runtime)`.
 *
 * jsgen emits byte-identical JS for LIST_SHOW/HIDE and VAR_SHOW/HIDE, so the
 * variable-vs-list distinction is unrecoverable here. We pick the VAR_* form; it is
 * equivalent modulo which monitor the id points at, which the id itself already decides.
 */
function matchMonitorToggle(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const arg = n.arguments[0] as ASTNode;
    if (!arg || arg.type !== 'ObjectExpression') return null;
    let id: string | null = null;
    let value: boolean | null = null;
    let isCheckbox = false;
    for (const prop of arg.properties) {
        if (prop.type !== 'Property') continue;
        const key = idName(prop.key);
        if (key === 'id') id = litStr(prop.value);
        else if (key === 'element') isCheckbox = litStr(prop.value) === 'checkbox';
        else if (key === 'value') value = litBool(prop.value);
    }
    if (id === null || value === null || !isCheckbox) return null;
    // jsgen emits byte-identical JS for LIST_SHOW/HIDE and VAR_SHOW/HIDE; the id is the only
    // clue, and only the project knows whether that id names a list. Fall back to VAR_* when
    // we have no list registry.
    if (ctx.listIds && ctx.listIds.has(id)) {
        const list: DescendedVariable = { scope: 'target', id, name: id, isCloud: false };
        return block(value ? StackOpcode.LIST_SHOW : StackOpcode.LIST_HIDE, { list });
    }
    const variable: DescendedVariable = { scope: 'target', id, name: id, isCloud: false };
    return block(value ? StackOpcode.VAR_SHOW : StackOpcode.VAR_HIDE, { variable });
}

/** List mutations expressed as method calls on `<ref>.value`. */
function matchListMethod(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const callee = n.callee as ASTNode;
    if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null;
    const list = resolveVarRef(callee.object, ctx);
    if (!list) return null;
    switch (callee.property.name) {
    case 'push':
        return block(StackOpcode.LIST_ADD, { list, item: compileExpr(n.arguments[0], ctx) });
    case 'pop':
        return block(StackOpcode.LIST_DELETE, { list, index: makeConstant('last') });
    case 'shift':
        return block(StackOpcode.LIST_DELETE, { list, index: makeConstant(1) });
    case 'unshift':
        return block(StackOpcode.LIST_INSERT, { list, index: makeConstant(1), item: compileExpr(n.arguments[0], ctx) });
    default:
        return null;
    }
}

/** `startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: <name> })` */
function matchBroadcast(callNode: Node, ctx: DecompileContext, andWait: boolean): IntermediateStackBlock | null {
    const n = callNode as ASTNode;
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'startHats') return null;
    const second = n.arguments[1] as ASTNode;
    if (!second || second.type !== 'ObjectExpression') return null;
    for (const prop of second.properties) {
        if (prop.type === 'Property' && idName(prop.key) === 'BROADCAST_OPTION') {
            return new IntermediateStackBlock(
                andWait ? StackOpcode.EVENT_BROADCAST_AND_WAIT : StackOpcode.EVENT_BROADCAST,
                { broadcast: compileExpr(prop.value, ctx) }, andWait,
            );
        }
    }
    return null;
}

/**
 * `thread.procedures["<variant>"](args...)`, optionally behind `yield*` when the
 * callee itself yields.
 */
function matchProcedureCall(n: ASTNode, ctx: DecompileContext, yields = false): IntermediateStackBlock[] | null {
    const callee = n.callee as ASTNode;
    if (callee.type !== 'MemberExpression') return null;
    if (!isPath(callee.object, ctx, 'thread.procedures')) return null;
    // jsgen emits `thread.procedures["variant"]` (computed, string literal); a minifier
    // may rewrite that to `thread.procedures.variant` (non-computed identifier) when the
    // variant string is a valid identifier. Accept both forms.
    const variant = idName(callee.property);
    if (variant === null) return null;
    if (ctx.observed && !ctx.observed.calls.includes(variant)) ctx.observed.calls.push(variant);
    return block(StackOpcode.PROCEDURE_CALL, {
        code: variant.substring(1), // strip the W/Z warp marker
        variant,
        arguments: n.arguments.map((a: Node) => compileExpr(a, ctx)),
    }, yields);
}

function compileCall(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const path = pathOf(n.callee, ctx);

    if (path !== null) {
        const zero = NO_ARG_CALLS[path];
        if (zero) return block(zero);
        const one = ONE_ARG_CALLS[path];
        if (one) {
            const [opcode, input, index] = one;
            const arg = n.arguments[index];
            if (arg) return block(opcode, { [input]: compileExpr(arg, ctx) });
        }
    }

    switch (path) {
    case 'target.setEffect':
        return matchSetEffect(n, ctx);
    case 'target.setXY':
        return matchSetXY(n, ctx);
    case 'target.setVisible': {
        const v = litBool(n.arguments[0]);
        if (v !== null) return block(v ? StackOpcode.LOOKS_SHOW : StackOpcode.LOOKS_HIDE);
        return null;
    }
    case 'target.setSize': {
        const delta = addendOver(n.arguments[0], ctx, 'target.size');
        if (delta) return block(StackOpcode.LOOKS_SIZE_CHANGE, { size: compileExpr(delta, ctx) });
        return block(StackOpcode.LOOKS_SIZE_SET, { size: compileExpr(n.arguments[0], ctx) });
    }
    case 'target.setCostume': {
        // `target.setCostume(target.currentCostume + 1)` is "next costume"
        if (isLit(addendOver(n.arguments[0], ctx, 'target.currentCostume'), 1)) {
            return block(StackOpcode.LOOKS_COSTUME_NEXT);
        }
        return block(StackOpcode.LOOKS_COSTUME_SET, { costume: compileExpr(n.arguments[0], ctx) });
    }
    case 'target.setRotationStyle': {
        const style = litStr(n.arguments[0]);
        if (style !== null) return block(StackOpcode.MOTION_ROTATION_STYLE_SET, { style });
        return null;
    }
    case 'runtime.ext_scratch3_looks._setBackdrop': {
        // 3-arg form (`stage.currentCostume + 1, true`) is "next backdrop"
        if (n.arguments.length >= 3 && isLit(addendOver(n.arguments[1], ctx, 'stage.currentCostume'), 1)) {
            return block(StackOpcode.LOOKS_BACKDROP_NEXT);
        }
        return block(StackOpcode.LOOKS_BACKDROP_SET, { backdrop: compileExpr(n.arguments[1], ctx) });
    }
    case 'runtime.ext_pen._setOrChangeColorParam': {
        const isChange = litBool(n.arguments[3]);
        return block(isChange ? StackOpcode.PEN_COLOR_PARAM_CHANGE : StackOpcode.PEN_COLOR_PARAM_SET, {
            param: compileExpr(n.arguments[0], ctx),
            value: compileExpr(n.arguments[1], ctx),
        });
    }
    case 'runtime.monitorBlocks.changeBlock':
        return matchMonitorToggle(n, ctx);
    case 'runtime.stopAll':
        return block(StackOpcode.CONTROL_STOP_ALL, {}, true);
    case 'listReplace': {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) {
            return block(StackOpcode.LIST_REPLACE, {
                list, index: compileExpr(n.arguments[1], ctx), item: compileExpr(n.arguments[2], ctx),
            });
        }
        return null;
    }
    case 'listInsert': {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) {
            return block(StackOpcode.LIST_INSERT, {
                list, index: compileExpr(n.arguments[1], ctx), item: compileExpr(n.arguments[2], ctx),
            });
        }
        return null;
    }
    case 'listDelete': {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) return block(StackOpcode.LIST_DELETE, { list, index: compileExpr(n.arguments[1], ctx) });
        return null;
    }
    case 'retire':
        return block(StackOpcode.CONTROL_STOP_SCRIPT);
    case 'startHats': {
        const bc = matchBroadcast(n, ctx, false);
        return bc ? [bc] : null;
    }
    }

    return matchProcedureCall(n, ctx) ?? matchListMethod(n, ctx);
}

// ---------------------------------------------------------------------------
// Compatibility-layer stack recognizers (blocks jsgen could not compile natively)
// ---------------------------------------------------------------------------

/**
 * Build a COMPATIBILITY_LAYER stack block from a `yield* executeInCompatibilityLayer(...)` call.
 * `substacks` carries branch bodies for conditional/loop compat blocks (keyed by branch number).
 */
function buildCompatStack(call: ASTNode, ctx: DecompileContext, substacks: Record<number, IntermediateStack> = {}): IntermediateStackBlock[] | null {
    const fnIdent = idName(call.arguments[1]);
    if (fnIdent === null) return null;
    const opcode = opcodeOfCompatFn(ctx, fnIdent);
    if (opcode === null) return null;
    const { inputs, fields } = parseCompatArgs(call.arguments[0], ctx);
    const id = litStr(call.arguments[4]);
    return block(StackOpcode.COMPATIBILITY_LAYER, { opcode, id, inputs, fields, substacks }, true);
}

/** A bare `yield* executeInCompatibilityLayer({...}, fn, isWarp, setFlags, "id", null);` command. */
function matchCompatStack(node: Node, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const n = node as ASTNode;
    if (n.type !== 'YieldExpression' || !n.delegate || !n.argument) return null;
    const call = n.argument as ASTNode;
    if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'executeInCompatibilityLayer') return null;
    // The bare command form passes `null` as the branch-info argument (6th slot).
    const branchInfo = call.arguments[5] as ASTNode;
    if (branchInfo && branchInfo.type === 'Literal' && branchInfo.value === null) {
        return buildCompatStack(call, ctx);
    }
    return null;
}

/**
 * A conditional/loop compat block: jsgen wraps it as
 *   const bN_branch = createBranchInfo(true|false);
 *   while (bN_branch.branch = +(yield* executeInCompatibilityLayer({...}, fn, isWarp, false, "id", bN_branch))) {
 *     switch (bN_branch.branch) { case 1: { <SUBSTACK> break; } case 2: { <SUBSTACK2> break; } }
 *     if (!bN_branch.isLoop) break; <yieldLoop noise>
 *   }
 * The branch bodies live in the switch; everything else is noise we drop.
 */
function matchCompatStackLoop(node: Node, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const n = node as ASTNode;
    if (n.type !== 'WhileStatement') return null;
    const test = n.test as ASTNode;
    if (test.type !== 'AssignmentExpression' || test.operator !== '=') return null;
    const rhs = test.right as ASTNode;
    if (rhs.type !== 'UnaryExpression' || rhs.operator !== '+') return null;
    const yieldExpr = rhs.argument as ASTNode;
    if (yieldExpr.type !== 'YieldExpression' || !yieldExpr.delegate || !yieldExpr.argument) return null;
    const call = yieldExpr.argument as ASTNode;
    if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'executeInCompatibilityLayer') return null;

    const substacks: Record<number, IntermediateStack> = {};
    for (const stmt of bodyOf(n.body)) {
        const s = stmt as ASTNode;
        if (s.type !== 'SwitchStatement') continue;
        for (const c of s.cases) {
            const num = c.test && c.test.type === 'Literal' ? Number(c.test.value) : NaN;
            if (isNaN(num)) continue;
            const cons = c.consequent as ASTNode[];
            const block = cons.length === 1 && cons[0].type === 'BlockStatement' ? cons[0] : { type: 'BlockStatement', body: cons };
            substacks[num] = new IntermediateStack(compileStatements(bodyOf(block), ctx));
        }
    }
    // The while body (after the switch) holds the warp-timer tail (`if (isStuck()) yield;`),
    // which this matcher consumes without compiling through isNoise -- record it here.
    if (ctx.observed && bodyOf(n.body).some(isStuckYield)) ctx.observed.stuckYield = true;
    return buildCompatStack(call, ctx, substacks);
}

// ---------------------------------------------------------------------------
// Assignment-statement recognizers
// ---------------------------------------------------------------------------

/**
 * Peel the numeric casts jsgen puts around a value so the underlying expression is visible.
 * Handles `toNotNaN(+x)` (upstream), `+x`, and 02scratch-vm's inline `(+x || 0)`.
 */
function stripNumericCast(node: ASTNode): ASTNode {
    let n = node;
    for (;;) {
        if (n.type === 'CallExpression' && n.callee.type === 'Identifier' &&
            n.callee.name === 'toNotNaN' && n.arguments.length === 1) {
            n = n.arguments[0] as ASTNode;
            continue;
        }
        if (n.type === 'UnaryExpression' && n.operator === '+') {
            n = n.argument as ASTNode;
            continue;
        }
        if (n.type === 'LogicalExpression' && n.operator === '||' &&
            n.right.type === 'Literal' && n.right.value === 0) {
            n = n.left as ASTNode;
            continue;
        }
        return n;
    }
}

function compileAssignment(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    // `runtime.ext_scratch3_control._counter = 0;`
    if (isPath(n.left, ctx, 'runtime.ext_scratch3_control._counter') && isLit(n.right, 0)) {
        return block(StackOpcode.CONTROL_CLEAR_COUNTER);
    }

    if (n.left.type !== 'MemberExpression' || idName(n.left.property) !== 'value') return null;
    const v = resolveVarRef(n.left, ctx);
    if (!v) return null;

    // `<list>.value = [];`
    if (n.right.type === 'ArrayExpression' && n.right.elements.length === 0) {
        return block(StackOpcode.LIST_DELETE_ALL, { list: v });
    }

    // `<var>.value = <var>.value + X;` -- "change variable by".
    // The self-reference is wrapped in jsgen's numeric cast (`(+v || 0)` in 02scratch-vm,
    // `toNotNaN(+v)` upstream), so unwrap it before comparing against the assignment target.
    const delta = n.right.type === 'BinaryExpression' && n.right.operator === '+'
        ? (sameVar(resolveVarRef(stripNumericCast(n.right.left), ctx), v) ? n.right.right
            : sameVar(resolveVarRef(stripNumericCast(n.right.right), ctx), v) ? n.right.left : null)
        : null;
    if (delta) {
        return block(StackOpcode.VAR_SET, {
            variable: v,
            value: new IntermediateInput(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, {
                left: new IntermediateInput(InputOpcode.VAR_GET, InputType.ANY, { variable: v }),
                right: compileExpr(delta, ctx),
            }),
        });
    }

    return block(StackOpcode.VAR_SET, { variable: v, value: compileExpr(n.right, ctx) });
}

// ---------------------------------------------------------------------------
// Multi-statement patterns
// ---------------------------------------------------------------------------

interface MultiMatch {
    blocks: IntermediateStackBlock[];
    consumed: number;
}

/** `runtime.stopAll(); retire(); return;` -> a single CONTROL_STOP_ALL. */
function matchStopAll(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    const call = soleCall(stmts[i]);
    if (!call || pathOf(call.callee, ctx) !== 'runtime.stopAll') return null;
    return {
        blocks: block(StackOpcode.CONTROL_STOP_ALL, {}, true),
        consumed: 1 + retireRun(stmts, i + 1),
    };
}

/** `retire(); return;` -> a single CONTROL_STOP_SCRIPT. */
function matchRetire(stmts: Node[], i: number): MultiMatch | null {
    const run = retireRun(stmts, i);
    if (run === 0) return null;
    return { blocks: block(StackOpcode.CONTROL_STOP_SCRIPT), consumed: run };
}

/** `Math.max(0, 1000 * <seconds>)` -> the seconds input. */
function matchWaitDuration(node: Node | null | undefined, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    if (!n || n.type !== 'CallExpression' || pathOf(n.callee, ctx) !== 'Math.max') return null;
    if (!isLit(n.arguments[0], 0)) return null;
    const scaled = n.arguments[1] as ASTNode;
    if (!scaled || scaled.type !== 'BinaryExpression' || scaled.operator !== '*') return null;
    if (isLit(scaled.left, 1000)) return compileExpr(scaled.right, ctx);
    if (isLit(scaled.right, 1000)) return compileExpr(scaled.left, ctx);
    return null;
}

/**
 * ```
 * thread.timer = timer();
 * var d = Math.max(0, 1000 * <seconds>);
 * runtime.requestRedraw(); yield;
 * while (thread.timer.timeElapsed() < d) { yield; }
 * thread.timer = null;
 * ```
 */
function matchControlWait(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    const cur = stmts[i] as ASTNode;
    if (cur.type !== 'ExpressionStatement') return null;
    const e = cur.expression as ASTNode;
    if (e.type !== 'AssignmentExpression' || !isPath(e.left, ctx, 'thread.timer')) return null;
    if (e.right.type !== 'CallExpression' || pathOf(e.right.callee, ctx) !== 'timer') return null;

    // the loop that burns down the timer terminates the pattern
    let end = -1;
    for (let j = i + 1; j < stmts.length && j <= i + 6; j++) {
        const s = stmts[j] as ASTNode;
        if (s.type === 'WhileStatement' && s.test.type === 'BinaryExpression' &&
            pathOf(s.test.left?.callee, ctx) === 'thread.timer.timeElapsed') {
            end = j;
            break;
        }
    }
    if (end === -1) return null;

    // The timer loop body holds the warp-timer tail (`if (isStuck()) yield;`), which this
    // matcher consumes without compiling through isNoise -- record it here so script.warpTimer is recovered.
    if (ctx.observed && bodyOf((stmts[end] as ASTNode).body).some(isStuckYield)) {
        ctx.observed.stuckYield = true;
    }

    let seconds: IntermediateInput | null = null;
    for (let j = i + 1; j < end; j++) {
        const s = stmts[j] as ASTNode;
        if (s.type !== 'VariableDeclaration') continue;
        seconds = matchWaitDuration(s.declarations[0]?.init, ctx);
        if (seconds) break;
    }

    return {
        blocks: block(StackOpcode.CONTROL_WAIT, { seconds: seconds ?? makeConstant(0) }, true),
        consumed: end - i + 1,
    };
}

/** `var i = 0; while (i < <count>) { i++; <ref>.value = i; <body> }` -> CONTROL_FOR. */
function matchControlFor(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    const decl = stmts[i] as ASTNode;
    if (decl.type !== 'VariableDeclaration' || decl.declarations.length !== 1) return null;
    const d = decl.declarations[0];
    if (d.id.type !== 'Identifier' || !isLit(d.init, 0)) return null;
    const counter = d.id.name;

    // javascript-obfuscator may drop its decoder helper functions between the
    // counter declaration and the loop; skip such noise.
    let wi = i + 1;
    while (wi < stmts.length && isNoise(stmts[wi], ctx)) wi++;
    const w = stmts[wi] as ASTNode;
    if (!w || w.type !== 'WhileStatement') return null;
    if (w.test.type !== 'BinaryExpression' || w.test.operator !== '<') return null;
    if (w.test.left.type !== 'Identifier' || w.test.left.name !== counter) return null;

    const body = expandSequenceBody(bodyOf(w.body));
    if (body.length < 2) return null;
    const incr = body[0] as ASTNode;
    if (incr.type !== 'ExpressionStatement' || incr.expression.type !== 'UpdateExpression' ||
        incr.expression.operator !== '++' || incr.expression.argument.name !== counter) return null;
    const assign = body[1] as ASTNode;
    if (assign.type !== 'ExpressionStatement' || assign.expression.type !== 'AssignmentExpression') return null;
    if (assign.expression.right.type !== 'Identifier' || assign.expression.right.name !== counter) return null;
    const variable = resolveVarRef(assign.expression.left, ctx);
    if (!variable) return null;

    loopHasWarpTimer(body, ctx);
    return {
        blocks: block(StackOpcode.CONTROL_FOR, {
            variable,
            count: compileExpr(w.test.right, ctx),
            do: new IntermediateStack(compileStatements(body.slice(2), ctx)),
        }),
        consumed: wi - i + 1,
    };
}

/**
 * `<ref>.value = X; runtime.ioDevices.cloud.requestUpdateVariable("name", <ref>.value);`
 * The follow-up call is how we learn the variable was a cloud variable.
 */
function matchCloudVarSet(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    const call = soleCall(stmts[i + 1]);
    if (!call || pathOf(call.callee, ctx) !== 'runtime.ioDevices.cloud.requestUpdateVariable') return null;
    const cur = stmts[i] as ASTNode;
    if (cur.type !== 'ExpressionStatement' || cur.expression.type !== 'AssignmentExpression') return null;
    const blocks = compileAssignment(cur.expression, ctx);
    if (!blocks || blocks[0].opcode !== StackOpcode.VAR_SET) return null;
    const variable = blocks[0].inputs.variable as DescendedVariable;
    variable.isCloud = true;
    const name = litStr(call.arguments[0]);
    if (name !== null) variable.name = name;
    return { blocks, consumed: 2 };
}

/** `const v = X; if (v !== undefined) runtime.visualReport("id", v);` */
function matchVisualReport(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    const decl = stmts[i] as ASTNode;
    if (decl.type !== 'VariableDeclaration' || decl.declarations.length !== 1) return null;
    const d = decl.declarations[0];
    if (d.id.type !== 'Identifier' || !d.init) return null;
    const next = stmts[i + 1] as ASTNode;
    if (!next || next.type !== 'IfStatement') return null;
    const call = soleCall(next.consequent);
    if (!call || pathOf(call.callee, ctx) !== 'runtime.visualReport') return null;
    // jsgen inlines script.topBlockId here; it is the only place it survives compilation
    // 02scratch-vm (TW) emits `visualReport("id", value)` (2-arg form);
    // vanilla scratch-vm emits `visualReport(target, "id", value)` (3-arg form).
    const topBlockId = litStr(call.arguments[0]) ?? litStr(call.arguments[1]);
    if (topBlockId !== null && ctx.observed) ctx.observed.topBlockId = topBlockId;
    return { blocks: block(StackOpcode.VISUAL_REPORT, { input: compileExpr(d.init, ctx) }), consumed: 2 };
}

function matchMulti(stmts: Node[], i: number, ctx: DecompileContext): MultiMatch | null {
    return matchStopAll(stmts, i, ctx)
        ?? matchRetire(stmts, i)
        ?? matchControlWait(stmts, i, ctx)
        ?? matchControlFor(stmts, i, ctx)
        ?? matchVisualReport(stmts, i, ctx)
        ?? matchCloudVarSet(stmts, i, ctx);
}

// ---------------------------------------------------------------------------
// Structured statements
// ---------------------------------------------------------------------------

/** `for (var i = <times>; i > 0; i--)` / `i >= 0.5` -> CONTROL_REPEAT. */
function matchRepeat(node: Node, ctx: DecompileContext): { times: IntermediateInput } | null {
    const n = node as ASTNode;
    if (n.init?.type !== 'VariableDeclaration' || n.init.declarations.length !== 1) return null;
    const d = n.init.declarations[0];
    if (d.id.type !== 'Identifier' || !d.init) return null;
    const counter = d.id.name;
    if (n.test?.type !== 'BinaryExpression') return null;
    if (n.test.left.type !== 'Identifier' || n.test.left.name !== counter) return null;
    if (n.test.operator !== '>' && n.test.operator !== '>=') return null;
    if (n.test.right.type !== 'Literal') return null;
    if (n.update?.type !== 'UpdateExpression' || n.update.operator !== '--' ||
        n.update.argument.type !== 'Identifier' || n.update.argument.name !== counter) return null;
    return { times: compileExpr(d.init, ctx) };
}

/**
 * ```
 * { const resolvedValue = <condition>; const id = "<id>"; ...
 *   if (!edgeWasActivated) { retire(); } yield; }
 * ```
 */
function matchHatEdge(node: Node, ctx: DecompileContext): IntermediateStackBlock[] | null {
    const stmts = bodyOf(node);
    let condition: Node | null = null;
    let id = '';
    let sawEdgeCheck = false;
    for (const s of stmts) {
        const n = s as ASTNode;
        if (n.type === 'VariableDeclaration') {
            for (const d of n.declarations) {
                if (d.id.type !== 'Identifier') continue;
                if (d.id.name === 'resolvedValue') condition = d.init;
                else if (d.id.name === 'id') id = litStr(d.init) ?? '';
                else if (d.id.name === 'edgeWasActivated') sawEdgeCheck = true;
            }
        }
    }
    if (!condition || !sawEdgeCheck) return null;
    if (ctx.observed) ctx.observed.executableHat = true;
    return block(StackOpcode.HAT_EDGE, { id, condition: compileExpr(condition, ctx) }, true);
}

/** `if (!target.isOriginal) { runtime.disposeTarget(target); ... }` */
function isCloneDelete(n: ASTNode, ctx: DecompileContext): boolean {
    const t = n.test as ASTNode;
    if (t.type !== 'UnaryExpression' || t.operator !== '!' || !isPath(t.argument, ctx, 'target.isOriginal')) return false;
    return bodyOf(n.consequent).some(s => {
        const e = (s as ASTNode).expression;
        return e?.type === 'CallExpression' && pathOf(e.callee, ctx) === 'runtime.disposeTarget';
    });
}

/** `if (!<condition>) { retire(); }` at the top of a script -> HAT_PREDICATE. */
function matchHatPredicate(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] | null {
    if (n.alternate) return null;
    const t = n.test as ASTNode;
    if (t.type !== 'UnaryExpression' || t.operator !== '!') return null;
    const inner = bodyOf(n.consequent);
    if (retireRun(inner, 0) !== inner.length) return null;
    if (ctx.observed) ctx.observed.executableHat = true;
    return block(StackOpcode.HAT_PREDICATE, { condition: compileExpr(t.argument, ctx) }, true);
}

function compileIf(n: ASTNode, ctx: DecompileContext, atStart: boolean): IntermediateStackBlock[] {
    if (isCloneDelete(n, ctx)) return block(StackOpcode.CONTROL_CLONE_DELETE);
    if (atStart) {
        const hat = matchHatPredicate(n, ctx);
        if (hat) return hat;
    }
    return block(StackOpcode.CONTROL_IF_ELSE, {
        condition: compileExpr(n.test, ctx),
        whenTrue: compileBlock(n.consequent, ctx),
        whenFalse: n.alternate ? compileBlock(n.alternate, ctx) : new IntermediateStack(),
    });
}

/**
 * javascript-obfuscator compiles `if (c) {A} else {B}` to a statement-level ternary
 * `c ? A : B`. Each branch is a bare expression; wrap it as a single-expression statement.
 */
function compileTernary(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] {
    return block(StackOpcode.CONTROL_IF_ELSE, {
        condition: compileExpr(n.test, ctx),
        whenTrue: compileTernaryBranch(n.consequent, ctx),
        whenFalse: compileTernaryBranch(n.alternate, ctx),
    });
}

function compileTernaryBranch(expr: Node, ctx: DecompileContext): IntermediateStack {
    const e = expr as ASTNode;
    if (e.type === 'SequenceExpression') {
        return new IntermediateStack(compileStatements(e.expressions.map((x: ASTNode) => ({
            type: 'ExpressionStatement', expression: x, start: x.start, end: x.end,
        })), ctx));
    }
    const stmt: ASTNode = { type: 'ExpressionStatement', expression: e, start: e.start, end: e.end };
    return new IntermediateStack(compileStatements([stmt], ctx));
}

/**
 * A loop whose tail yield is `if (isStuck()) yield;` was compiled from a warp script
 * that had a warp timer -- that is the only combination jsgen emits it for.
 */
function loopHasWarpTimer(bodyStmts: Node[], ctx: DecompileContext): boolean {
    const warpTimer = bodyStmts.some(isStuckYield);
    if (warpTimer && ctx.observed) ctx.observed.stuckYield = true;
    return warpTimer;
}

function compileWhile(n: ASTNode, ctx: DecompileContext): IntermediateStackBlock[] {
    const bodyStmts = bodyOf(n.body);
    const body = compileStatements(bodyStmts, ctx);
    const t = n.test as ASTNode;
    // `while (!<cond>) { yield; }` with nothing else in the body is "wait until <cond>"
    if (body.length === 0 && t.type === 'UnaryExpression' && t.operator === '!') {
        return block(StackOpcode.CONTROL_WAIT_UNTIL, { condition: compileExpr(t.argument, ctx) }, true);
    }
    return block(StackOpcode.CONTROL_WHILE, {
        condition: compileExpr(n.test, ctx),
        do: new IntermediateStack(body),
        warpTimer: loopHasWarpTimer(bodyStmts, ctx),
    });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Compile a statement list, honouring patterns that span several statements. */
export function compileStatements(stmts: Node[], ctx: DecompileContext, atStart = false): IntermediateStackBlock[] {
    const out: IntermediateStackBlock[] = [];
    let i = 0;
    while (i < stmts.length) {
        // javascript-obfuscator joins a run of statements with commas; give the
        // multi-statement matchers a chance to see each one individually first.
        const s = stmts[i] as ASTNode;
        if (s.type === 'ExpressionStatement' && s.expression.type === 'SequenceExpression') {
            const parts = expandSequenceBody([s]);
            if (parts.length > 1) {
                stmts.splice(i, 1, ...parts);
                continue;
            }
        }
        if (isNoise(stmts[i], ctx)) {
            i++;
            continue;
        }
        const multi = matchMulti(stmts, i, ctx);
        if (multi) {
            out.push(...multi.blocks);
            i += multi.consumed;
            continue;
        }
        out.push(...compileStatement(stmts[i], ctx, atStart && out.length === 0));
        i++;
    }
    return out;
}

/** Compile a body (block or single statement) into an IntermediateStack. */
export function compileBlock(node: Node, ctx: DecompileContext, atStart = false): IntermediateStack {
    return new IntermediateStack(compileStatements(bodyOf(node), ctx, atStart));
}

/** Compile a single statement node into zero or more IntermediateStackBlocks. */
export function compileStatement(node: Node, ctx: DecompileContext, atStart = false): IntermediateStackBlock[] {
    const n = node as ASTNode;
    switch (n.type) {
    case 'BlockStatement': {
        const hat = matchHatEdge(node, ctx);
        if (hat) return hat;
        return compileStatements(n.body, ctx, atStart);
    }
    case 'ExpressionStatement': {
        const e = n.expression as ASTNode;
        // compat-layer command: `yield* executeInCompatibilityLayer(...);`
        if (e.type === 'YieldExpression' && e.delegate) {
            const cs = matchCompatStack(e, ctx);
            if (cs) return cs;
        }
        if (e.type === 'CallExpression') return compileCall(e, ctx) ?? [];
        if (e.type === 'AssignmentExpression') return compileAssignment(e, ctx) ?? [];
        // `runtime.ext_scratch3_control._counter++;`
        if (e.type === 'UpdateExpression' && e.operator === '++' &&
            isPath(e.argument, ctx, 'runtime.ext_scratch3_control._counter')) {
            return block(StackOpcode.CONTORL_INCR_COUNTER);
        }
        // deobfuscated source: javascript-obfuscator joins statement sequences with commas
        if (e.type === 'SequenceExpression') {
            const out: IntermediateStackBlock[] = [];
            for (const part of e.expressions) {
                if (part.type === 'CallExpression') out.push(...(compileCall(part, ctx) ?? []));
                else if (part.type === 'AssignmentExpression') out.push(...(compileAssignment(part, ctx) ?? []));
                else if (part.type === 'UpdateExpression' && part.operator === '++' &&
                    isPath(part.argument, ctx, 'runtime.ext_scratch3_control._counter')) {
                    out.push(...block(StackOpcode.CONTORL_INCR_COUNTER));
                } else if (part.type === 'ConditionalExpression') {
                    out.push(...compileTernary(part, ctx));
                }
            }
            return out;
        }
        // deobfuscated source: `if (c) A;` compiles to `c && A` and `if (!c) A;` to `c || A`
        // (javascript-obfuscator's simplify turns if-statements into logical short-circuits).
        if (e.type === 'LogicalExpression') {
            const test = e.operator === '||'
                ? { type: 'UnaryExpression', operator: '!', prefix: true, argument: e.left, start: (e.left as ASTNode).start, end: (e.left as ASTNode).end }
                : e.left;
            return block(StackOpcode.CONTROL_IF_ELSE, {
                condition: compileExpr(test as ASTNode, ctx),
                whenTrue: compileTernaryBranch(e.right, ctx),
                whenFalse: new IntermediateStack(),
            });
        }
        // deobfuscated source: `if (c) A; else B;` compiles to a statement-level ternary
        if (e.type === 'ConditionalExpression') return compileTernary(e, ctx);
        // `yield* waitThreads(startHats(...));`
        if (e.type === 'YieldExpression' && e.delegate && e.argument?.type === 'CallExpression') {
            const inner = e.argument as ASTNode;
            if (inner.callee.type === 'Identifier' && inner.callee.name === 'waitThreads') {
                const bc = matchBroadcast(inner.arguments[0], ctx, true);
                if (bc) return [bc];
            }
            // `yield* thread.procedures["..."](...)` for a yielding procedure
            return matchProcedureCall(inner, ctx, true) ?? [];
        }
        return [];
    }
    case 'IfStatement':
        return compileIf(n, ctx, atStart);
    case 'WhileStatement': {
        const cl = matchCompatStackLoop(n, ctx);
        if (cl) return cl;
        return compileWhile(n, ctx);
    }
    case 'ForStatement': {
        const rep = matchRepeat(node, ctx);
        if (!rep) return [];
        const bodyStmts = bodyOf(n.body);
        loopHasWarpTimer(bodyStmts, ctx);
        return block(StackOpcode.CONTROL_REPEAT, {
            times: rep.times,
            do: new IntermediateStack(compileStatements(bodyStmts, ctx)),
        });
    }
    case 'ReturnStatement': {
        // jsgen's stopScript() in a procedure emits `return "";`
        if (!n.argument || isLit(n.argument, '')) return block(StackOpcode.CONTROL_STOP_SCRIPT);
        return block(StackOpcode.PROCEDURE_RETURN, { value: compileExpr(n.argument, ctx) });
    }
    case 'DebuggerStatement':
        return block(StackOpcode.DEBUGGER);
    case 'VariableDeclaration':
    default:
        return [];
    }
}
