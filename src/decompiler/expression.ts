import type { Node } from 'estree';
import { IntermediateInput, InputOpcode, InputType } from './ir';
import { DecompileContext, DescendedVariable, ASTNode, DecompileError } from './types';
import { tryConst } from './constants';

function idName(p: Node | null | undefined): string | null {
    if (!p) return null;
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
    return null;
}

function isLiteral(node: Node, value: unknown): boolean {
    return node.type === 'Literal' && node.value === value;
}

function isMathMember(node: Node, name: string): boolean {
    return node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Math' &&
        node.property.type === 'Identifier' && node.property.name === name;
}

function isMathPI(node: Node): boolean {
    return isMathMember(node, 'PI');
}

export function makeConstant(value: unknown): IntermediateInput {
    if (typeof value === 'number') {
        return new IntermediateInput(InputOpcode.CONSTANT, IntermediateInput.getNumberInputType(value), { value });
    }
    if (typeof value === 'boolean') {
        return new IntermediateInput(InputOpcode.CONSTANT, InputType.BOOLEAN, { value });
    }
    // jsgen serializes a colour constant as a 3-element numeric array literal.
    if (Array.isArray(value)) {
        return new IntermediateInput(InputOpcode.CONSTANT, InputType.COLOR, { value });
    }
    return new IntermediateInput(InputOpcode.CONSTANT, InputType.STRING, { value: String(value) });
}

/**
 * Match a dotted, non-computed member path such as `runtime.ioDevices.mouse.getIsDown`.
 * String-literal properties (`obj["prop"]`) are accepted too, so deobfuscated source that
 * restored strings as computed accesses still matches.
 */
function isPath(node: Node, path: string): boolean {
    const parts = path.split('.');
    let n = node as ASTNode;
    for (let i = parts.length - 1; i > 0; i--) {
        if (n.type !== 'MemberExpression') return false;
        if (n.computed && !(n.property.type === 'Literal' && typeof n.property.value === 'string')) return false;
        if (idName(n.property) !== parts[i]) return false;
        n = n.object as ASTNode;
    }
    return n.type === 'Identifier' && n.name === parts[0];
}

/** Match `target.variables["id"]` / `stage.variables["id"]` (also `target["variables"]["id"]`). */
function matchVarLookup(node: Node, targetVar: string, stageVar: string): DescendedVariable | null {
    const n = node as ASTNode;
    if (n.type !== 'MemberExpression') return null;
    // jsgen emits `target.variables["id"]` (computed); a minifier may rewrite to
    // `target.variables.id` (non-computed) when id is a valid identifier. Accept both.
    const propId = idName(n.property);
    if (propId === null) return null;
    const inner = n.object as ASTNode;
    if (inner.type !== 'MemberExpression') return null;
    if (inner.computed && idName(inner.property) === null) return null;
    if (idName(inner.property) !== 'variables') return null;
    if (inner.object.type !== 'Identifier') return null;
    if (inner.object.name !== targetVar && inner.object.name !== stageVar) return null;
    return {
        scope: inner.object.name === targetVar ? 'target' : 'stage',
        id: propId,
        name: propId,
        isCloud: false,
    };
}

/** Resolve a variable/list reference (possibly hoisted via a setup const, possibly with or without `.value`). */
export function resolveVarRef(node: Node, ctx: DecompileContext): DescendedVariable | null {
    let base: Node = node;
    if (node.type === 'MemberExpression' && idName(node.property) === 'value') {
        base = (node as ASTNode).object;
    }
    if (base.type === 'Identifier' && ctx.setupConsts.has(base.name)) {
        const hoisted = ctx.setupConsts.get(base.name)!;
        if (hoisted) base = hoisted;
    }
    return matchVarLookup(base, ctx.targetVar, ctx.stageVar);
}

function sameVar(a: DescendedVariable | null, b: DescendedVariable | null): boolean {
    return !!a && !!b && a.scope === b.scope && a.id === b.id;
}

function extractDegArg(node: Node): Node | null {
    const n = node as ASTNode;
    if (n.type !== 'BinaryExpression' || n.operator !== '/') return null;
    if (!isLiteral(n.right, 180)) return null;
    const left = n.left;
    if (left.type !== 'BinaryExpression' || left.operator !== '*') return null;
    if (!isMathPI(left.left)) return null;
    return left.right;
}

/** Recognize scratch's trig/math call shapes (incl. the wrapping divisions) and map to InputOpcode.OP_*. */
function matchTrig(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    const mapFn: Record<string, any> = { sin: InputOpcode.OP_SIN, cos: InputOpcode.OP_COS, tan: InputOpcode.OP_TAN };
    const mapInv: Record<string, any> = { asin: InputOpcode.OP_ASIN, acos: InputOpcode.OP_ACOS, atan: InputOpcode.OP_ATAN };
    // `round` is handled separately: it doubles as the "size" reporter and as the trig wrapper.
    const mapPlain: Record<string, any> = {
        abs: InputOpcode.OP_ABS, sqrt: InputOpcode.OP_SQRT, floor: InputOpcode.OP_FLOOR,
        ceil: InputOpcode.OP_CEILING, exp: InputOpcode.OP_POW_E, log: InputOpcode.OP_LOG_E,
    };
    const mathCall = (c: ASTNode): { name: string; args: any[] } | null =>
        c.type === 'CallExpression' && c.callee.type === 'MemberExpression' &&
        c.callee.object.type === 'Identifier' && c.callee.object.name === 'Math' &&
        c.callee.property.type === 'Identifier'
            ? { name: c.callee.property.name, args: c.arguments }
            : null;

    // `Math.round(target.size)` is the "size" reporter, NOT a generic round (must win over mapPlain).
    if (n.type === 'CallExpression' && isMethod(n.callee, 'Math', 'round') && n.arguments.length === 1) {
        const arg = n.arguments[0] as ASTNode;
        if (arg.type === 'MemberExpression' && !arg.computed && arg.object.type === 'Identifier' && arg.object.name === ctx.targetVar &&
            arg.property.type === 'Identifier' && arg.property.name === 'size') {
            return new IntermediateInput(InputOpcode.LOOKS_SIZE_GET, InputType.NUMBER_POS | InputType.NUMBER_ZERO, {});
        }
    }
    // jsgen emits the global `tan(x)`, not Math.tan(x).
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'tan' && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.OP_TAN, InputType.NUMBER_OR_NAN, { value: compileExpr(n.arguments[0] as ASTNode, ctx) });
    }

    // `Math.log(x) / Math.LN10` is the base-10 log operator (jsgen never emits Math.log10).
    if (n.type === 'BinaryExpression' && n.operator === '/' && isMathMember(n.right, 'LN10')) {
        const fn = mathCall(n.left as ASTNode);
        if (fn && fn.name === 'log' && fn.args.length === 1) {
            return new IntermediateInput(InputOpcode.OP_LOG_10, InputType.NUMBER_OR_NAN, { value: compileExpr(fn.args[0], ctx) });
        }
    }

    let callNode: ASTNode = n;
    if (n.type === 'BinaryExpression' && n.operator === '/' && isLiteral(n.right, 1e10) && n.left.type === 'CallExpression') {
        callNode = n.left;
    }
    const a = mathCall(callNode);
    if (a) {
        if (a.name === 'round' && a.args.length === 1) {
            const inner = a.args[0];
            if (inner.type === 'BinaryExpression' && inner.operator === '*' && isLiteral(inner.right, 1e10) && inner.left.type === 'CallExpression') {
                const fn = mathCall(inner.left);
                if (fn && mapFn[fn.name]) {
                    const arg = extractDegArg(fn.args[0]);
                    if (arg) return new IntermediateInput(mapFn[fn.name], InputType.NUMBER_OR_NAN, { value: compileExpr(arg, ctx) });
                }
            }
            // A `Math.round(...) / 1e10` that is not a trig shape: leave the division to the caller.
            if (callNode !== n) return null;
            return new IntermediateInput(InputOpcode.OP_ROUND, InputType.NUMBER, { value: compileExpr(a.args[0], ctx) });
        }
        if (mapInv[a.name] && a.args.length === 1) {
            return new IntermediateInput(mapInv[a.name], InputType.NUMBER_OR_NAN, { value: compileExpr(a.args[0], ctx) });
        }
        if (mapPlain[a.name] && a.args.length === 1) {
            return new IntermediateInput(mapPlain[a.name], InputType.NUMBER_OR_NAN, { value: compileExpr(a.args[0], ctx) });
        }
        return null;
    }
    if (n.type === 'BinaryExpression' && n.operator === '/' && isMathPI(n.right) &&
        n.left.type === 'BinaryExpression' && n.left.operator === '*' && isLiteral(n.left.right, 180) &&
        n.left.left.type === 'CallExpression') {
        const fn = mathCall(n.left.left);
        if (fn && mapInv[fn.name] && fn.args.length === 1) {
            return new IntermediateInput(mapInv[fn.name], InputType.NUMBER_OR_NAN, { value: compileExpr(fn.args[0], ctx) });
        }
    }
    return null;
}

/** True if `callee` is `<obj>.<method>(...)` (non-computed member call). */
function isMethod(callee: Node, obj: string, method: string): boolean {
    const c = callee as ASTNode;
    return c.type === 'MemberExpression' && !c.computed &&
        c.object.type === 'Identifier' && c.object.name === obj &&
        c.property.type === 'Identifier' && c.property.name === method;
}

/** True if `callee` is `runtime.ext_<ext>.<method>(...)`. */
function isExtMethod(callee: Node, ext: string, method: string, ctx: DecompileContext): boolean {
    const c = callee as ASTNode;
    return c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === method &&
        c.object.type === 'MemberExpression' && !c.computed && c.object.property.type === 'Identifier' && c.object.property.name === ext &&
        c.object.object.type === 'Identifier' && c.object.object.name === ctx.runtimeVar;
}

/**
 * `a.toLowerCase().indexOf(b.toLowerCase()) !== -1` is jsgen's emission for the
 * "contains" operator. Recover it as OP_CONTAINS.
 */
function matchContains(n: Node, ctx: DecompileContext): IntermediateInput | null {
    const node = n as ASTNode;
    if (node.type !== 'BinaryExpression') return null;
    if (node.operator !== '!==' && node.operator !== '!=') return null;
    // `-1` parses as a unary negation, not a literal.
    const minusOne = tryConst(node.right);
    if (!minusOne || minusOne.value !== -1) return null;
    const left = node.left as ASTNode;
    if (left.type !== 'CallExpression') return null;
    const c = left.callee as ASTNode;
    if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier' || c.property.name !== 'indexOf') return null;
    const recv = c.object as ASTNode;
    if (!(recv.type === 'CallExpression' && recv.callee.type === 'MemberExpression' && !recv.callee.computed &&
        recv.callee.property.type === 'Identifier' && recv.callee.property.name === 'toLowerCase')) {
        return null;
    }
    const containsArg = left.arguments[0] as ASTNode;
    if (!(containsArg.type === 'CallExpression' && containsArg.callee.type === 'MemberExpression' && !containsArg.callee.computed &&
        containsArg.callee.property.type === 'Identifier' && containsArg.callee.property.name === 'toLowerCase')) {
        return null;
    }
    return new IntermediateInput(InputOpcode.OP_CONTAINS, InputType.BOOLEAN, {
        string: compileExpr((recv.callee as ASTNode).object, ctx),
        contains: compileExpr((containsArg.callee as ASTNode).object, ctx),
    });
}

/**
 * Undo 02scratch-vm's strength reduction of a division into a multiplication:
 * `x * 0.5` -> `x / 2`, `x * 0.25` -> `x / 4`.
 *
 * Multiplying by a power of two is bit-identical to dividing by its reciprocal, so inverting
 * is semantically safe and restores the block the project actually contained.
 */
function matchStrengthReducedDivide(left: IntermediateInput, right: IntermediateInput): IntermediateInput | null {
    const divisorFor = (v: unknown): number | null => (v === 0.5 ? 2 : v === 0.25 ? 4 : null);
    const isConst = (i: IntermediateInput | null): boolean => !!i && i.opcode === InputOpcode.CONSTANT;
    let divisor = isConst(right) ? divisorFor((right as IntermediateInput).inputs.value) : null;
    let numerator = left;
    if (divisor === null) {
        divisor = isConst(left) ? divisorFor((left as IntermediateInput).inputs.value) : null;
        numerator = right;
    }
    if (divisor === null) return null;
    return new IntermediateInput(InputOpcode.OP_DIVIDE, InputType.NUMBER_OR_NAN, {
        left: numerator,
        right: makeConstant(divisor),
    });
}

function binOpToInput(op: string): any | null {
    switch (op) {
    case '+': return InputOpcode.OP_ADD;
    case '-': return InputOpcode.OP_SUBTRACT;
    case '*': return InputOpcode.OP_MULTIPLY;
    case '/': return InputOpcode.OP_DIVIDE;
    case '%': return InputOpcode.OP_MOD;
    case '===': case '==': return InputOpcode.OP_EQUALS;
    case '!==': case '!=': return InputOpcode.OP_EQUALS; // wrapped in OP_NOT by the caller
    case '>': return InputOpcode.OP_GREATER;
    case '<': return InputOpcode.OP_LESS;
    case '<=': return InputOpcode.OP_GREATER; // negated by the caller
    case '>=': return InputOpcode.OP_LESS; // negated by the caller
    default: return null;
    }
}

function notOf(operand: IntermediateInput): IntermediateInput {
    return new IntermediateInput(InputOpcode.OP_NOT, InputType.BOOLEAN, { operand });
}

/** True if this operand of a `+` proves the operator is "join" rather than "add". */
function isStringish(node: Node, compiled: IntermediateInput): boolean {
    if (compiled.opcode === InputOpcode.CAST_STRING) return true;
    return node.type === 'Literal' && typeof node.value === 'string';
}

/**
 * 02scratch-vm inline CAST_NUMBER: `(+expr || 0)`.
 * The `||` has a `UnaryExpression(+)` left and literal `0` right.
 */
function matchInlineCastNumber(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    if (n.type !== 'LogicalExpression' || n.operator !== '||') return null;
    if (!isLiteral(n.right, 0)) return null;
    const left = n.left as ASTNode;
    if (left.type !== 'UnaryExpression' || left.operator !== '+') return null;
    return new IntermediateInput(InputOpcode.CAST_NUMBER, InputType.NUMBER, { target: compileExpr(left.argument, ctx) });
}

/** Check if two AST nodes are structurally identical (shallow, for `expr === expr`). */
function nodesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'Identifier') return a.name === b.name;
    if (a.type === 'Literal') return a.value === b.value;
    if (a.type === 'MemberExpression') {
        return a.computed === b.computed && nodesEqual(a.object, b.object) && nodesEqual(a.property, b.property);
    }
    if (a.type === 'UnaryExpression') return a.operator === b.operator && nodesEqual(a.argument, b.argument);
    if (a.type === 'BinaryExpression' || a.type === 'LogicalExpression') {
        return a.operator === b.operator && nodesEqual(a.left, b.left) && nodesEqual(a.right, b.right);
    }
    if (a.type === 'CallExpression') {
        if (!nodesEqual(a.callee, b.callee)) return false;
        if ((a.arguments?.length || 0) !== (b.arguments?.length || 0)) return false;
        return a.arguments.every((arg: any, i: number) => nodesEqual(arg, b.arguments[i]));
    }
    return false;
}

/**
 * 02scratch-vm inline CAST_BOOLEAN patterns:
 *   (expr !== 0 && expr === expr)          — number-to-boolean
 *   (expr !== 0)                            — integer-to-boolean (single check)
 *   (expr !== '' && expr !== '0' && expr.toLowerCase() !== 'false') — string-to-boolean
 */
function matchInlineCastBoolean(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;

    // Single check: (expr !== 0) — only when we can tell this is a CAST_BOOLEAN, not OP_NOT_EQUALS.
    // We can't always distinguish, so we only match the `&&` chain patterns below.
    if (n.type !== 'LogicalExpression' || n.operator !== '&&') return null;

    // Pattern: (expr !== 0 && expr === expr)
    if (n.left.type === 'BinaryExpression' && n.left.operator === '!==' && isLiteral(n.left.right, 0) &&
        n.right.type === 'BinaryExpression' && n.right.operator === '===' &&
        nodesEqual(n.right.left, n.right.right) && nodesEqual(n.right.left, n.left.left)) {
        return new IntermediateInput(InputOpcode.CAST_BOOLEAN, InputType.BOOLEAN, { target: compileExpr(n.left.left, ctx) });
    }

    // Pattern: (... && expr !== 0 && expr === expr) — the `&&` is left-assoc, so the
    // outer right is `expr === expr` and outer left is the preceding chain.
    if (n.right.type === 'BinaryExpression' && n.right.operator === '===' &&
        nodesEqual(n.right.left, n.right.right)) {
        // The expr being cast is n.right.left; check the outer left ends with `expr !== 0`
        if (n.left.type === 'BinaryExpression' && n.left.operator === '!==' && isLiteral(n.left.right, 0) &&
            nodesEqual(n.left.left, n.right.left)) {
            return new IntermediateInput(InputOpcode.CAST_BOOLEAN, InputType.BOOLEAN, { target: compileExpr(n.right.left, ctx) });
        }
        // Deeper chain: ((A && B) && expr === expr)
        if (n.left.type === 'LogicalExpression' && n.left.operator === '&&' &&
            n.left.right.type === 'BinaryExpression' && n.left.right.operator === '!==' && isLiteral(n.left.right.right, 0) &&
            nodesEqual(n.left.right.left, n.right.left)) {
            return new IntermediateInput(InputOpcode.CAST_BOOLEAN, InputType.BOOLEAN, { target: compileExpr(n.right.left, ctx) });
        }
    }

    // Pattern: (expr !== '' && expr !== '0' && expr.toLowerCase() !== 'false')
    // Left-assoc: ((expr !== '' && expr !== '0') && expr.toLowerCase() !== 'false')
    if (n.right.type === 'BinaryExpression' && n.right.operator === '!==' && isLiteral(n.right.right, 'false') &&
        n.right.left.type === 'CallExpression' && n.right.left.callee.type === 'MemberExpression' &&
        !n.right.left.callee.computed && n.right.left.callee.property.type === 'Identifier' &&
        n.right.left.callee.property.name === 'toLowerCase') {
        // The expr being cast is the receiver of .toLowerCase()
        const exprNode = n.right.left.callee.object;
        // Check left chain: (expr !== '' && expr !== '0')
        if (n.left.type === 'LogicalExpression' && n.left.operator === '&&' &&
            n.left.right.type === 'BinaryExpression' && n.left.right.operator === '!==' && isLiteral(n.left.right.right, '0') &&
            n.left.left.type === 'BinaryExpression' && n.left.left.operator === '!==' && isLiteral(n.left.left.right, '') &&
            nodesEqual(n.left.left.left, exprNode) && nodesEqual(n.left.right.left, exprNode)) {
            return new IntermediateInput(InputOpcode.CAST_BOOLEAN, InputType.BOOLEAN, { target: compileExpr(exprNode, ctx) });
        }
    }

    return null;
}

/** `(ref.value[i - 1] ?? "")` / `(ref.value[ref.value.length - 1] ?? "")` -> "item i of list". */
function matchListGetNullish(n: ASTNode, ctx: DecompileContext): IntermediateInput | null {
    if (!(n.right.type === 'Literal' && n.right.value === '')) return null;
    const left = n.left as ASTNode;
    if (left.type !== 'MemberExpression' || !left.computed) return null;
    const list = resolveVarRef(left.object, ctx);
    if (!list) return null;
    const idx = left.property as ASTNode;

    // last: ref.value[ref.value.length - 1]
    if (idx.type === 'BinaryExpression' && idx.operator === '-' &&
        idx.left.type === 'MemberExpression' && !idx.left.computed && idName(idx.left.property) === 'length') {
        return new IntermediateInput(InputOpcode.LIST_GET, InputType.ANY, { list, index: makeConstant('last') });
    }
    // general: ref.value[X - 1]
    if (idx.type === 'BinaryExpression' && idx.operator === '-' && isLiteral(idx.right, 1)) {
        return new IntermediateInput(InputOpcode.LIST_GET, InputType.ANY, { list, index: compileExpr(idx.left, ctx) });
    }
    // Index already constant-folded: jsgen emits `item 1 of list` as `[1 - 1]`, and a constant
    // folder (the deobfuscator, or the packager's own minifier) may reduce that to `[0]`.
    // Recover the 1-based index from the literal rather than losing the block.
    const folded = tryConst(idx);
    if (folded && typeof folded.value === 'number' && Number.isFinite(folded.value)) {
        return new IntermediateInput(InputOpcode.LIST_GET, InputType.ANY, { list, index: makeConstant(folded.value + 1) });
    }
    return null;
}

/** The `<something> + 1` reporters: costume/backdrop number and current month/day-of-week. */
function matchPlusOne(n: ASTNode, ctx: DecompileContext): IntermediateInput | null {
    const costumeNum = matchCostumeNumber(n, ctx);
    if (costumeNum) return costumeNum;
    const one = isLiteral(n.right, 1) ? (n.left as ASTNode) : isLiteral(n.left, 1) ? (n.right as ASTNode) : null;
    if (!one) return null;
    const method = dateMethod(one);
    if (method === 'getMonth') return new IntermediateInput(InputOpcode.SENSING_TIME_MONTH, InputType.NUMBER_POS_INT, {});
    if (method === 'getDay') return new IntermediateInput(InputOpcode.SENSING_TIME_WEEKDAY, InputType.NUMBER_POS_INT, {});
    return null;
}

function compatInput(node: Node): never {
    throw new DecompileError(`unhandled expression node: ${node.type}`);
}

/**
 * Produce a fallback constant input for an unrecognized expression node,
 * so a single unrecognized pattern doesn't crash the entire decompilation.
 */
function fallbackCompatInput(node: Node, ctx: DecompileContext): IntermediateInput {
    return makeConstant(0);
}

/**
 * jsgen routes any block it cannot map to a native IR opcode through the compatibility
 * layer: `yield* executeInCompatibilityLayer({...args...}, <fn>, <isWarp>, <setFlags>, "<id>", <branchInfo>)`.
 * The `<fn>` is a hoisted `const bK = runtime.getOpcodeFunction("<OPCODE>")`, so the original Scratch
 * opcode survives in the JS. A compat reporter appears as `(yield* executeInCompatibilityLayer(...))`
 * -- a delegate YieldExpression -- while a compat command appears as `yield* executeInCompatibilityLayer(...);`.
 */

/** Recover the opcode from the hoisted `const bK = runtime.getOpcodeFunction("OPCODE")`. */
export function opcodeOfCompatFn(ctx: DecompileContext, fnIdent: string): string | null {
    const hoisted = ctx.setupConsts.get(fnIdent);
    if (!hoisted || hoisted.type !== 'CallExpression') return null;
    const callee = hoisted.callee as ASTNode;
    const isGetOpcode = callee.type === 'MemberExpression' && !callee.computed &&
        callee.property.type === 'Identifier' && callee.property.name === 'getOpcodeFunction' &&
        callee.object.type === 'Identifier' && callee.object.name === ctx.runtimeVar;
    if (!isGetOpcode) return null;
    const arg = hoisted.arguments[0] as ASTNode;
    if (arg && arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
    return null;
}

/**
 * Parse the compat object literal into {inputs, fields}. jsgen emits inputs as compiled
 * expressions and fields as quoted string literals, so a *literal* value is taken as a field
 * and everything else as an input. (A constant-string input and a string field are therefore
 * indistinguishable in the JS; the serializer refines the split via block info. This matches the
 * structure of scratch-vm's own COMPATIBILITY_LAYER IR node.)
 *
 * Numeric and boolean literals are always inputs: jsgen serializes field values as
 * `"${sanitize(field)}"` (always quoted strings), while a CONSTANT input of number/boolean
 * type is emitted as a bare literal (10, true). Only string literals are ambiguous.
 */
export function parseCompatArgs(objLiteral: Node, ctx: DecompileContext): { inputs: Record<string, IntermediateInput>; fields: Record<string, any> } {
    const inputs: Record<string, IntermediateInput> = {};
    const fields: Record<string, any> = {};
    const obj = objLiteral as ASTNode;
    if (obj.type !== 'ObjectExpression') return { inputs, fields };
    for (const prop of obj.properties) {
        const p = prop as ASTNode;
        if (p.type !== 'Property') continue;
        // jsgen emits unquoted identifier keys; be tolerant of quoted string-literal keys too.
        const key = propKeyName(p.key);
        if (key === null) continue;
        const val = p.value as ASTNode;
        if (val.type === 'Literal' && typeof val.value === 'string') {
            fields[key] = val.value;
        } else {
            inputs[key] = compileExpr(val, ctx);
        }
    }
    return { inputs, fields };
}

/** Object property key as a string, whether it is an Identifier or a string Literal. */
function propKeyName(key: Node | null | undefined): string | null {
    const k = key as ASTNode;
    if (!k) return null;
    if (k.type === 'Identifier') return k.name;
    if (k.type === 'Literal' && typeof k.value === 'string') return k.value;
    return null;
}

/** If `node` is `yield* executeInCompatibilityLayer(...)` used as a reporter value, return its call. */
function matchCompatYield(node: Node): ASTNode | null {
    const n = node as ASTNode;
    if (n.type !== 'YieldExpression' || !n.delegate || !n.argument) return null;
    const arg = n.argument as ASTNode;
    if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && arg.callee.name === 'executeInCompatibilityLayer') {
        return arg;
    }
    return null;
}

/** Read a string literal value (null if not a string literal). */
function litStr(node: Node | null | undefined): string | null {
    const n = node as ASTNode;
    return n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null;
}

/**
 * Build a COMPATIBILITY_LAYER input from a `yield* executeInCompatibilityLayer(...)` call.
 * Returns null if the opcode cannot be recovered (e.g. the fn const is missing).
 */
export function buildCompatInput(call: ASTNode, ctx: DecompileContext): IntermediateInput | null {
    const fnIdent = idName(call.arguments[1]);
    if (fnIdent === null) return null;
    const opcode = opcodeOfCompatFn(ctx, fnIdent);
    if (opcode === null) return null;
    const { inputs, fields } = parseCompatArgs(call.arguments[0], ctx);
    const id = litStr(call.arguments[4]);
    return new IntermediateInput(InputOpcode.COMPATIBILITY_LAYER, InputType.ANY, {
        opcode, id, inputs, fields,
    }, true);
}

/** Recognize a compat-layer reporter expression. */
export function matchCompatibilityLayerInput(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const call = matchCompatYield(node);
    if (!call) return null;
    return buildCompatInput(call, ctx);
}

/** Map a CallExpression to an IntermediateInput (reporters / intrinsics). Returns null if not recognized. */
function matchReporter(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    const callee = n.callee;

    // -- list reporters --
    if (callee.type === 'Identifier' && callee.name === 'listGet' && n.arguments.length === 2) {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) return new IntermediateInput(InputOpcode.LIST_GET, InputType.ANY, { list, index: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'listContains' && n.arguments.length === 2) {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) return new IntermediateInput(InputOpcode.LIST_CONTAINS, InputType.BOOLEAN, { list, item: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'listIndexOf' && n.arguments.length === 2) {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) return new IntermediateInput(InputOpcode.LIST_INDEX_OF, InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO, { list, item: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'listContents' && n.arguments.length === 1) {
        const list = resolveVarRef(n.arguments[0], ctx);
        if (list) return new IntermediateInput(InputOpcode.LIST_CONTENTS, InputType.STRING, { list });
    }
    if (callee.type === 'Identifier' && callee.name === 'distance' && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.SENSING_DISTANCE, InputType.NUMBER, { target: compileExpr(n.arguments[0], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'compareEqual' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_EQUALS, InputType.BOOLEAN, { left: compileExpr(n.arguments[0], ctx), right: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'compareGreaterThan' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_GREATER, InputType.BOOLEAN, { left: compileExpr(n.arguments[0], ctx), right: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'compareLessThan' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_LESS, InputType.BOOLEAN, { left: compileExpr(n.arguments[0], ctx), right: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'mod' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_MOD, InputType.NUMBER_OR_NAN, { left: compileExpr(n.arguments[0], ctx), right: compileExpr(n.arguments[1], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'randomInt' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_RANDOM, InputType.NUMBER, {
            low: compileExpr(n.arguments[0], ctx), high: compileExpr(n.arguments[1], ctx), useInts: true, useFloats: false,
        });
    }
    if (callee.type === 'Identifier' && callee.name === 'randomFloat' && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_RANDOM, InputType.NUMBER, {
            low: compileExpr(n.arguments[0], ctx), high: compileExpr(n.arguments[1], ctx), useInts: false, useFloats: true,
        });
    }
    if (callee.type === 'Identifier' && callee.name === 'toBoolean' && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.CAST_BOOLEAN, InputType.BOOLEAN, { target: compileExpr(n.arguments[0], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'toNotNaN' && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.CAST_NUMBER, InputType.NUMBER, { target: compileExpr(n.arguments[0], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'colorToList' && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.CAST_COLOR, InputType.COLOR, { target: compileExpr(n.arguments[0], ctx) });
    }
    if (callee.type === 'Identifier' && callee.name === 'daysSince2000' && n.arguments.length === 0) {
        return new IntermediateInput(InputOpcode.SENSING_TIME_DAYS_SINCE_2000, InputType.NUMBER, {});
    }

    // -- current date/time: `new Date().getX()` (the +1 forms are matched by the caller) --
    const date = matchDateCall(n);
    if (date) return date;

    // -- math / trig (and a few look/motion getters emitted via Math.*) --
    if (callee.type === 'Identifier' && callee.name === 'limitPrecision' && n.arguments.length === 1) {
        const arg = n.arguments[0];
        if (arg.type === 'MemberExpression' && !arg.computed && arg.object.type === 'Identifier' && arg.object.name === ctx.targetVar) {
            if (arg.property.type === 'Identifier' && arg.property.name === 'x') return new IntermediateInput(InputOpcode.MOTION_X_GET, InputType.NUMBER, {});
            if (arg.property.type === 'Identifier' && arg.property.name === 'y') return new IntermediateInput(InputOpcode.MOTION_Y_GET, InputType.NUMBER, {});
        }
    }
    if (isExtMethod(callee, 'ext_scratch3_operators', '_random', ctx) && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.OP_RANDOM, InputType.NUMBER_OR_NAN, {
            low: compileExpr(n.arguments[0], ctx), high: compileExpr(n.arguments[1], ctx), useInts: false, useFloats: false,
        });
    }
    const trig = matchTrig(node, ctx);
    if (trig) return trig;

    // -- sensing: mouse / keyboard / clock / userdata --
    if (isPath(callee, 'runtime.ioDevices.keyboard.getKeyIsDown') && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.SENSING_KEY_DOWN, InputType.BOOLEAN, { key: compileExpr(n.arguments[0], ctx) });
    }
    if (isPath(callee, 'runtime.ioDevices.mouse.getIsDown')) {
        return new IntermediateInput(InputOpcode.SENSING_MOUSE_DOWN, InputType.BOOLEAN, {});
    }
    if (isPath(callee, 'runtime.ioDevices.mouse.getScratchX')) {
        return new IntermediateInput(InputOpcode.SENSING_MOUSE_X, InputType.NUMBER, {});
    }
    if (isPath(callee, 'runtime.ioDevices.mouse.getScratchY')) {
        return new IntermediateInput(InputOpcode.SENSING_MOUSE_Y, InputType.NUMBER, {});
    }
    if (isPath(callee, 'runtime.ioDevices.clock.projectTimer')) {
        return new IntermediateInput(InputOpcode.SENSING_TIMER_GET, InputType.NUMBER, {});
    }
    if (isPath(callee, 'runtime.ioDevices.userData.getUsername')) {
        return new IntermediateInput(InputOpcode.SENSING_USERNAME, InputType.STRING, {});
    }
    if (isPath(callee, 'runtime.ioDevices.keyboard.getLastKeyPressed')) {
        return new IntermediateInput(InputOpcode.TW_KEY_LAST_PRESSED, InputType.STRING, {});
    }
    if (isExtMethod(callee, 'ext_scratch3_sensing', 'getAttributeOf', ctx) && n.arguments.length === 1) {
        const arg = n.arguments[0] as ASTNode;
        if (arg.type === 'ObjectExpression') {
            let object: IntermediateInput | null = null;
            let property: string | null = null;
            for (const prop of arg.properties) {
                if (prop.type !== 'Property') continue;
                const k = idName(prop.key);
                if (k === 'OBJECT') object = compileExpr(prop.value as ASTNode, ctx);
                else if (k === 'PROPERTY') property = litStr(prop.value);
            }
            if (object && property) return new IntermediateInput(InputOpcode.SENSING_OF, InputType.ANY, { object, property });
        }
    }
    if (isMethod(callee, ctx.targetVar, 'isTouchingObject') && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.SENSING_TOUCHING_OBJECT, InputType.BOOLEAN, { object: compileExpr(n.arguments[0], ctx) });
    }
    if (isMethod(callee, ctx.targetVar, 'isTouchingColor') && n.arguments.length === 1) {
        return new IntermediateInput(InputOpcode.SENSING_TOUCHING_COLOR, InputType.BOOLEAN, { color: compileExpr(n.arguments[0], ctx) });
    }
    if (isMethod(callee, ctx.targetVar, 'colorIsTouchingColor') && n.arguments.length === 2) {
        return new IntermediateInput(InputOpcode.SENSING_COLOR_TOUCHING_COLOR, InputType.BOOLEAN, { target: compileExpr(n.arguments[0], ctx), mask: compileExpr(n.arguments[1], ctx) });
    }

    return null;
}

/**
 * `new Date().getX()` is jsgen's emission for the "current [year/…]" reporters.
 * The month/weekday variants are `(... + 1)` and are matched by the `+` handler instead.
 */
function matchDateCall(n: ASTNode): IntermediateInput | null {
    if (n.type !== 'CallExpression' || n.arguments.length !== 0) return null;
    const method = dateMethod(n);
    if (method === null) return null;
    switch (method) {
    case 'getFullYear': return new IntermediateInput(InputOpcode.SENSING_TIME_YEAR, InputType.NUMBER_POS_INT, {});
    case 'getDate': return new IntermediateInput(InputOpcode.SENSING_TIME_DATE, InputType.NUMBER_POS_INT, {});
    case 'getHours': return new IntermediateInput(InputOpcode.SENSING_TIME_HOUR, InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO, {});
    case 'getMinutes': return new IntermediateInput(InputOpcode.SENSING_TIME_MINUTE, InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO, {});
    case 'getSeconds': return new IntermediateInput(InputOpcode.SENSING_TIME_SECOND, InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO, {});
    default: return null;
    }
}

/** The method name of a `new Date().<method>()` call, or null. */
function dateMethod(n: ASTNode): string | null {
    if (n.type !== 'CallExpression') return null;
    const c = n.callee as ASTNode;
    if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return null;
    const recv = c.object as ASTNode;
    if (recv.type !== 'NewExpression' || recv.callee.type !== 'Identifier' || recv.callee.name !== 'Date') return null;
    return c.property.name;
}

/** Match a bare MemberExpression that is a sensor/reporter read. */
function matchMemberReporter(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    if (n.type !== 'MemberExpression') return null;

    // target.direction
    if (!n.computed && n.object.type === 'Identifier' && n.object.name === ctx.targetVar && n.property.type === 'Identifier' && n.property.name === 'direction') {
        return new IntermediateInput(InputOpcode.MOTION_DIRECTION_GET, InputType.NUMBER_REAL, {});
    }
    // list length vs string length: both compile to `<ref>.value.length`, but a *list* id
    // means LIST_LENGTH while a scalar variable means the "length of text" operator. The
    // listIds registry (from the project's declared lists) disambiguates them, mirroring
    // the LIST_SHOW/HIDE vs VAR_SHOW/HIDE monitor case.
    if (!n.computed && n.property.type === 'Identifier' && n.property.name === 'length') {
        const list = resolveVarRef(n.object, ctx);
        if (list && ctx.listIds && ctx.listIds.has(list.id)) {
            return new IntermediateInput(InputOpcode.LIST_LENGTH, InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO, { list });
        }
        return new IntermediateInput(InputOpcode.OP_LENGTH, InputType.NUMBER, { string: compileExpr(n.object, ctx) });
    }
    // costume / backdrop name chains: `T.getCostumes()[T.currentCostume].name`
    const costumeOwner = costumeNameChain(n);
    if (costumeOwner === ctx.targetVar) return new IntermediateInput(InputOpcode.LOOKS_COSTUME_NAME, InputType.STRING, {});
    if (costumeOwner === ctx.stageVar) return new IntermediateInput(InputOpcode.LOOKS_BACKDROP_NAME, InputType.STRING, {});

    // bare runtime state reads
    if (isPath(n, 'runtime.ext_scratch3_sensing._answer')) {
        return new IntermediateInput(InputOpcode.SENSING_ANSWER, InputType.STRING, {});
    }
    if (isPath(n, 'runtime.ext_scratch3_control._counter')) {
        return new IntermediateInput(InputOpcode.CONTROL_COUNTER, InputType.NUMBER_POS_REAL | InputType.NUMBER_ZERO, {});
    }
    return null;
}

/** `T.getCostumes()[T.currentCostume].name` -> the name of the identifier `T`, or null. */
function costumeNameChain(node: ASTNode): string | null {
    if (node.type !== 'MemberExpression' || node.computed || idName(node.property) !== 'name') return null;
    const idx = node.object as ASTNode;
    if (idx.type !== 'MemberExpression' || !idx.computed) return null;
    const prop = idx.property as ASTNode;
    if (prop.type !== 'MemberExpression' || prop.computed || idName(prop.property) !== 'currentCostume') return null;
    if (prop.object.type !== 'Identifier') return null;
    const tname = prop.object.name;
    const gc = idx.object as ASTNode;
    if (gc.type !== 'CallExpression' || gc.arguments.length !== 0) return null;
    const cal = gc.callee as ASTNode;
    if (cal.type !== 'MemberExpression' || cal.computed || idName(cal.property) !== 'getCostumes') return null;
    if (cal.object.type !== 'Identifier' || cal.object.name !== tname) return null;
    return tname;
}

/**
 * `string[letter - 1] || ""` is jsgen's emission for the "letter of" operator
 * (index is 1-based, missing falls back to "").
 */
function matchLetterOf(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    if (n.type !== 'LogicalExpression' || n.operator !== '||') return null;
    if (!(n.right.type === 'Literal' && n.right.value === '')) return null;
    const left = n.left as ASTNode;
    if (left.type !== 'MemberExpression' || !left.computed) return null;
    const prop = left.property as ASTNode;
    if (prop.type !== 'BinaryExpression' || prop.operator !== '-') return null;
    if (!(prop.right.type === 'Literal' && prop.right.value === 1)) return null;
    return new IntermediateInput(InputOpcode.OP_LETTER_OF, InputType.STRING, {
        string: compileExpr(left.object, ctx),
        letter: compileExpr(prop.left, ctx),
    });
}

/**
 * Resolve a target/object reference as used by the "attribute of" / sensing-of reporters.
 * jsgen emits `stage` for the stage and `runtime.getSpriteTargetByName("Name")` (hoisted) for
 * other targets; both are mapped back to the native object string.
 */
function resolveTargetRef(node: Node, ctx: DecompileContext): string | null {
    const n = node as ASTNode;
    if (n.type === 'Identifier') {
        if (n.name === ctx.stageVar) return '_stage_';
        // self / explicit sprite: only recoverable when jsgen resolved a sprite by name (see hoisted branch)
        if (n.name === ctx.targetVar) return ctx.targetVar;
    }
    let base: Node = n;
    if (n.type === 'Identifier' && ctx.setupConsts.has(n.name)) base = ctx.setupConsts.get(n.name)!;
    if (base.type === 'CallExpression') {
        const c = base.callee as ASTNode;
        if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === ctx.runtimeVar &&
            c.property.type === 'Identifier' && c.property.name === 'getSpriteTargetByName') {
            const a = base.arguments[0] as ASTNode;
            if (a.type === 'Literal' && typeof a.value === 'string') return a.value;
        }
    }
    return null;
}

/** Classify the consequent of a `T ? <attr> : 0` sensing-of wrapper. */
function sensingOfAttr(cons: ASTNode, tname: string, ctx: DecompileContext): { op: string; type: number } | null {
    // T.x / T.y / T.direction / T.size / T.volume
    if (cons.type === 'MemberExpression' && !cons.computed && cons.object.type === 'Identifier' && cons.object.name === tname) {
        switch (cons.property.name) {
        case 'x': return { op: InputOpcode.SENSING_OF_POS_X, type: InputType.NUMBER };
        case 'y': return { op: InputOpcode.SENSING_OF_POS_Y, type: InputType.NUMBER };
        case 'direction': return { op: InputOpcode.SENSING_OF_DIRECTION, type: InputType.NUMBER_REAL };
        case 'size': return { op: InputOpcode.SENSING_OF_SIZE, type: InputType.NUMBER_POS | InputType.NUMBER_ZERO };
        case 'volume': return { op: InputOpcode.SENSING_OF_VOLUME, type: InputType.NUMBER_POS_REAL | InputType.NUMBER_ZERO };
        }
    }
    // T.currentCostume + 1  ->  costume number (or backdrop number when T is the stage)
    if (cons.type === 'BinaryExpression' && cons.operator === '+' && isLiteral(cons.right, 1)) {
        const lm = cons.left as ASTNode;
        if (lm.type === 'MemberExpression' && !lm.computed && lm.object.type === 'Identifier' && lm.object.name === tname &&
            lm.property.type === 'Identifier' && lm.property.name === 'currentCostume') {
            return tname === ctx.stageVar
                ? { op: InputOpcode.SENSING_OF_BACKDROP_NUMBER, type: InputType.NUMBER_POS_INT }
                : { op: InputOpcode.SENSING_OF_COSTUME_NUMBER, type: InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO };
        }
    }
    // T.getCostumes()[T.currentCostume].name  ->  costume name (or backdrop name when T is the stage)
    if (costumeNameChain(cons) === tname) {
        return tname === ctx.stageVar
            ? { op: InputOpcode.SENSING_OF_BACKDROP_NAME, type: InputType.STRING }
            : { op: InputOpcode.SENSING_OF_COSTUME_NAME, type: InputType.STRING | InputType.NUMBER_ZERO };
    }
    return null;
}

/**
 * `bN ? bN.value : 0` where `const bN = <target> && <target>.lookupVariableByNameAndType("v", "", true)`
 * is jsgen's emission for "[variable] of [target]".
 */
function matchSensingOfVar(test: ASTNode, cons: ASTNode, ctx: DecompileContext): IntermediateInput | null {
    if (test.type !== 'Identifier') return null;
    if (cons.type !== 'MemberExpression' || cons.computed || idName(cons.property) !== 'value') return null;
    if (cons.object.type !== 'Identifier' || cons.object.name !== test.name) return null;
    const hoisted = ctx.setupConsts.get(test.name) as ASTNode | undefined;
    if (!hoisted || hoisted.type !== 'LogicalExpression' || hoisted.operator !== '&&') return null;
    const call = hoisted.right as ASTNode;
    if (call.type !== 'CallExpression') return null;
    const c = call.callee as ASTNode;
    if (c.type !== 'MemberExpression' || c.computed || idName(c.property) !== 'lookupVariableByNameAndType') return null;
    const object = resolveTargetRef(c.object, ctx);
    const property = litStr(call.arguments[0]);
    if (object === null || property === null) return null;
    return new IntermediateInput(InputOpcode.SENSING_OF_VAR, InputType.ANY, { object: makeConstant(object), property });
}

/** Recognize jsgen's null-safe "attribute of <target>" wrapper: `T ? <attr-of-T> : 0`. */
function matchSensingOf(node: Node, ctx: DecompileContext): IntermediateInput | null {
    const n = node as ASTNode;
    const alt = n.alternate as ASTNode;
    if (!(alt.type === 'Literal' && (alt.value === 0 || alt.value === '' || alt.value === false))) return null;
    const test = n.test as ASTNode;
    const cons = n.consequent as ASTNode;
    const ofVar = matchSensingOfVar(test, cons, ctx);
    if (ofVar) return ofVar;
    const obj = resolveTargetRef(test, ctx);
    if (obj === null) return null;
    const tname = test.type === 'Identifier' ? test.name : null;
    if (tname === null) return null;
    const r = sensingOfAttr(cons, tname, ctx);
    if (!r) return null;
    return new IntermediateInput(r.op as any, r.type, { object: makeConstant(obj) });
}

/**
 * Minimal constant folding for compileExpr. The ONLY expression we may fold is a
 * negative number literal (`-1`, `-0`): acorn parses it as a unary minus over a
 * positive literal, while the native IR stores a single CONSTANT. Everything else
 * must stay structural -- jsgen emits exactly what the IR holds, so folding binary
 * expressions or math calls (e.g. `(1 + 2)` -> 3) would break round-trip fidelity
 * on the constant operands that real projects produce.
 */
function tryConstFold(node: Node): { value: unknown } | null {
    const n = node as ASTNode;
    if (n.type === 'Literal') return { value: n.value };
    if (n.type === 'UnaryExpression' && n.operator === '-') {
        const a = tryConstFold(n.argument);
        if (a !== null && typeof a.value === 'number') return { value: -a.value };
        return null;
    }
    // jsgen emits Infinity/NaN as bare identifiers (CONSTANT.toString()).
    if (n.type === 'Identifier' && n.name === 'Infinity') return { value: Infinity };
    if (n.type === 'Identifier' && n.name === 'NaN') return { value: NaN };
    return null;
}

/** Compile a JS expression AST node into an IntermediateInput. */
export function compileExpr(node: Node, ctx: DecompileContext): IntermediateInput {
    const c = tryConstFold(node);
    if (c !== null) return makeConstant(c.value);

    const n = node as ASTNode;
    try {
        return compileExprInner(n, node, ctx);
    } catch (e) {
        if (e instanceof DecompileError) {
            return fallbackCompatInput(node, ctx);
        }
        throw e;
    }
}

function compileExprInner(n: ASTNode, node: Node, ctx: DecompileContext): IntermediateInput {
    switch (n.type) {
    case 'Literal':
        return makeConstant(n.value);
    case 'Identifier': {
        if (ctx.params.includes(n.name)) {
            return new IntermediateInput(InputOpcode.PROCEDURE_ARGUMENT, InputType.ANY, { index: ctx.params.indexOf(n.name) });
        }
        // jsgen emits Infinity/-Infinity/NaN as bare identifiers (via CONSTANT.toString()),
        // and TW's constant folding can also produce them. Recover as constants.
        if (n.name === 'Infinity') return makeConstant(Infinity);
        if (n.name === 'NaN') return makeConstant(NaN);
        return compatInput(node);
    }
    case 'MemberExpression': {
        const sensor = matchMemberReporter(node, ctx);
        if (sensor) return sensor;
        if (idName(n.property) === 'value') {
            const v = resolveVarRef(node, ctx);
            if (v) return new IntermediateInput(InputOpcode.VAR_GET, InputType.ANY, { variable: v });
        }
        return compatInput(node);
    }
    case 'UnaryExpression': {
        if (n.operator === '!') {
            // jsgen emits the ">" / "<" operators as `!(a <= b)` / `!(a >= b)` when the operand types
            // allow it; recover the positive comparison instead of a double negation.
            const arg = n.argument as ASTNode;
            if (arg.type === 'BinaryExpression' && (arg.operator === '<=' || arg.operator === '>=')) {
                const op = arg.operator === '<=' ? InputOpcode.OP_GREATER : InputOpcode.OP_LESS;
                return new IntermediateInput(op, InputType.BOOLEAN, {
                    left: compileExpr(arg.left, ctx), right: compileExpr(arg.right, ctx),
                });
            }
            return new IntermediateInput(InputOpcode.OP_NOT, InputType.BOOLEAN, { operand: compileExpr(n.argument, ctx) });
        }
        if (n.operator === '+') {
            return new IntermediateInput(InputOpcode.CAST_NUMBER, InputType.NUMBER, { target: compileExpr(n.argument, ctx) });
        }
        if (n.operator === '-') {
            return new IntermediateInput(InputOpcode.OP_SUBTRACT, InputType.NUMBER_OR_NAN, {
                left: makeConstant(0), right: compileExpr(n.argument, ctx),
            });
        }
        return compatInput(node);
    }
    case 'BinaryExpression': {
        if (n.operator === '|' && isLiteral(n.right, 0)) {
            return new IntermediateInput(InputOpcode.CAST_NUMBER_INDEX, InputType.NUMBER_INDEX, { target: compileExpr(n.left, ctx) });
        }
        const trig = matchTrig(node, ctx);
        if (trig) return trig;

        // "contains" operator: a.toLowerCase().indexOf(b.toLowerCase()) !== -1
        const contains = matchContains(node, ctx);
        if (contains) return contains;

        if (n.operator === '+') {
            // (X.currentCostume + 1) / (new Date().getMonth() + 1) / (new Date().getDay() + 1)
            const plusOne = matchPlusOne(n, ctx);
            if (plusOne) return plusOne;
            // ("" + x) is jsgen's string cast, not a join with an empty string
            if (isLiteral(n.left, '')) {
                return new IntermediateInput(InputOpcode.CAST_STRING, InputType.STRING, { target: compileExpr(n.right, ctx) });
            }
        }

        // `**` only ever comes from the "10 ^" operator.
        if (n.operator === '**') {
            if (!isLiteral(n.left, 10)) return compatInput(node);
            return new IntermediateInput(InputOpcode.OP_POW_10, InputType.NUMBER, { value: compileExpr(n.right, ctx) });
        }

        const op = binOpToInput(n.operator);
        if (!op) return compatInput(node);
        const left = compileExpr(n.left, ctx);
        const right = compileExpr(n.right, ctx);
        if (op === InputOpcode.OP_ADD) {
            // `+` is both "add" and "join"; a string operand means the latter.
            return isStringish(n.left, left) || isStringish(n.right, right)
                ? new IntermediateInput(InputOpcode.OP_JOIN, InputType.STRING, { left, right })
                : new IntermediateInput(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
        }
        if (op === InputOpcode.OP_MULTIPLY) {
            // 02scratch-vm's jsgen strength-reduces `x / 2` to `x * 0.5` and `x / 4` to
            // `x * 0.25`. Multiplying by a power of two is bit-identical to dividing by its
            // reciprocal, so inverting is semantically safe and restores the original block.
            const reduced = matchStrengthReducedDivide(left, right);
            if (reduced) return reduced;
            return new IntermediateInput(op, InputType.NUMBER_OR_NAN, { left, right });
        }
        if (op === InputOpcode.OP_SUBTRACT ||
            op === InputOpcode.OP_DIVIDE || op === InputOpcode.OP_MOD) {
            return new IntermediateInput(op, InputType.NUMBER_OR_NAN, { left, right });
        }
        // Scratch has no "not equal" / "at most" / "at least" operators; compose them from OP_NOT.
        if (n.operator === '!==' || n.operator === '!=') {
            return notOf(new IntermediateInput(InputOpcode.OP_EQUALS, InputType.BOOLEAN, { left, right }));
        }
        if (n.operator === '<=') {
            return notOf(new IntermediateInput(InputOpcode.OP_GREATER, InputType.BOOLEAN, { left, right }));
        }
        if (n.operator === '>=') {
            return notOf(new IntermediateInput(InputOpcode.OP_LESS, InputType.BOOLEAN, { left, right }));
        }
        return new IntermediateInput(op, InputType.BOOLEAN, { left, right });
    }
    case 'LogicalExpression': {
        // list item: (ref.value[idx - 1] ?? "")
        if (n.operator === '??') {
            const item = matchListGetNullish(n, ctx);
            if (item) return item;
            return compatInput(node);
        }
        const letter = matchLetterOf(node, ctx);
        if (letter) return letter;

        // 02scratch-vm inline CAST_NUMBER: (+expr || 0)
        const castNum = matchInlineCastNumber(node, ctx);
        if (castNum) return castNum;

        // 02scratch-vm inline CAST_BOOLEAN patterns:
        //   (expr !== 0 && expr === expr)
        //   (expr !== 0)
        //   (expr !== '' && expr !== '0' && expr.toLowerCase() !== 'false')
        const castBool = matchInlineCastBoolean(node, ctx);
        if (castBool) return castBool;

        const op = n.operator === '&&' ? InputOpcode.OP_AND : InputOpcode.OP_OR;
        return new IntermediateInput(op, InputType.BOOLEAN, {
            left: compileExpr(n.left, ctx), right: compileExpr(n.right, ctx),
        });
    }
    case 'CallExpression': {
        // .toLowerCase() passthrough (string normalization) -> compile the receiver
        if (n.callee.type === 'MemberExpression' && !n.callee.computed &&
            n.callee.property.type === 'Identifier' && n.callee.property.name === 'toLowerCase' && n.arguments.length === 0) {
            return compileExpr(n.callee.object, ctx);
        }
        const rep = matchReporter(node, ctx);
        if (rep) return rep;
        return compatInput(node);
    }
    case 'YieldExpression': {
        // compat-layer reporter: `(yield* executeInCompatibilityLayer(...))`
        const ci = matchCompatibilityLayerInput(node, ctx);
        if (ci) return ci;
        return compatInput(node);
    }
    case 'ConditionalExpression': {
        // jsgen's null-safe "attribute of <target>" wrapper: `T ? T.x : 0`
        const so = matchSensingOf(node, ctx);
        if (so) return so;
        return compatInput(node);
    }
    case 'ArrayExpression': {
        // colour constants are emitted as `[r,g,b]`
        const parts = n.elements.map((e: any) => (e && e.type === 'Literal' && typeof e.value === 'number' ? e.value : null));
        if (parts.length === 3 && parts.every((p: any) => p !== null)) return makeConstant(parts);
        return compatInput(node);
    }
    default:
        return compatInput(node);
    }
}

function matchCostumeNumber(n: ASTNode, ctx: DecompileContext): IntermediateInput | null {
    // (X.currentCostume + 1) or (1 + X.currentCostume)
    const isCostume = (side: Node): 'target' | 'stage' | null => {
        const s = side as ASTNode;
        if (s.type === 'MemberExpression' && !s.computed && s.property.type === 'Identifier' && s.property.name === 'currentCostume' &&
            s.object.type === 'Identifier') {
            return s.object.name === ctx.targetVar ? 'target' : s.object.name === ctx.stageVar ? 'stage' : null;
        }
        return null;
    };
    const oneIs = (a: Node, b: Node): boolean => (a.type === 'Literal' && a.value === 1) || (b.type === 'Literal' && b.value === 1);
    let which: 'target' | 'stage' | null = null;
    if (oneIs(n.left, n.right)) {
        which = isCostume(n.left) ?? isCostume(n.right);
    }
    if (which === 'target') return new IntermediateInput(InputOpcode.LOOKS_COSTUME_NUMBER, InputType.NUMBER_POS_INT, {});
    if (which === 'stage') return new IntermediateInput(InputOpcode.LOOKS_BACKDROP_NUMBER, InputType.NUMBER_POS_INT, {});
    return null;
}

export { resolveVarRef as _resolveVarRef, sameVar };
