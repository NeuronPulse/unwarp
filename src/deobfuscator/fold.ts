import type { Node } from 'estree';

/**
 * Evaluate an expression that is composed purely of literals and arithmetic / string
 * concatenation. Used to undo javascript-obfuscator's `numbersToExpressions` and
 * `splitStrings` (e.g. `0x1ca9*-0x1+-0xa0d*0x1+0x26e0` -> 42, `"look"+"s"` -> "looks").
 * Returns undefined when the expression is not a compile-time constant.
 */
export function foldExpr(node: Node): number | string | boolean | null | undefined {
    const n = node as any;
    switch (n.type) {
    case 'Literal':
        return n.value;
    case 'TemplateLiteral':
        if (n.expressions.length === 0 && n.quasis.length === 1) return n.quasis[0].value.cooked;
        return undefined;
    case 'Identifier':
        // jsgen emits Infinity/NaN as bare identifiers; a minifier or constant folder
        // may leave them as-is inside an arithmetic expression the obfuscator wrapped.
        if (n.name === 'undefined') return undefined;
        if (n.name === 'Infinity') return Infinity;
        if (n.name === 'NaN') return NaN;
        return undefined;
    case 'UnaryExpression': {
        if (n.operator === '!') {
            // `![]` -> false, `!![]` -> true (javascript-obfuscator's `numbersToExpressions`
            // renders booleans this way); any object literal is truthy.
            const v = foldExpr(n.argument);
            if (v === undefined || v === null) {
                if (n.argument.type === 'ArrayExpression' || n.argument.type === 'ObjectExpression') return false;
                return undefined;
            }
            return !v as boolean;
        }
        const v = foldExpr(n.argument);
        if (v === undefined || v === null) return undefined;
        switch (n.operator) {
        case '+': return +v as number;
        case '-': return -(v as number);
        case '~': return ~(v as number);
        default: return undefined;
        }
    }
    case 'BinaryExpression': {
        const l = foldExpr(n.left);
        const r = foldExpr(n.right);
        if (l === undefined || r === undefined) return undefined;
        if (l === null || r === null) return undefined;
        switch (n.operator) {
        case '+': return (l as any) + (r as any);
        case '-': return (l as number) - (r as number);
        case '*': return (l as number) * (r as number);
        case '/': return (l as number) / (r as number);
        case '%': return (l as number) % (r as number);
        case '**': return (l as number) ** (r as number);
        case '<<': return (l as number) << (r as number);
        case '>>': return (l as number) >> (r as number);
        case '>>>': return (l as number) >>> (r as number);
        case '&': return (l as number) & (r as number);
        case '|': return (l as number) | (r as number);
        case '^': return (l as number) ^ (r as number);
        default: return undefined;
        }
    }
    case 'LogicalExpression': {
        const l = foldExpr(n.left);
        const r = foldExpr(n.right);
        if (l === undefined || r === undefined) return undefined;
        if (n.operator === '&&') return l && r;
        if (n.operator === '||') return l || r;
        return undefined;
    }
    default:
        return undefined;
    }
}

/** Render a folded constant back to JS source text. */
export function renderConst(v: number | string | boolean | null): string {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null) return 'null';
    return String(v);
}
