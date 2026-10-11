import type { Node } from 'estree';
import { ASTNode } from './types';

/** Replicates scratch's toBoolean for constant folding. */
function toBoolean(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
    return !!v;
}

/**
 * If the whole expression subtree is statically known, return its value.
 * Otherwise return null. Used to fold constants (e.g. `(1 + 2)` -> 3),
 * which is allowed because the decompiled IR only needs to be equivalent.
 */
export function tryConst(node: Node): { value: unknown } | null {
    const n = node as ASTNode;
    switch (n.type) {
    case 'Literal':
        return { value: n.value };
    case 'UnaryExpression': {
        const a = tryConst(n.argument);
        if (!a) return null;
        switch (n.operator) {
        case '-': return { value: -(a.value as number) };
        case '+': return { value: +(a.value as any) };
        case '!': return { value: !(a.value as any) };
        default: return null;
        }
    }
    case 'BinaryExpression': {
        const l = tryConst(n.left);
        const r = tryConst(n.right);
        if (!l || !r) return null;
        const a = l.value as any;
        const b = r.value as any;
        switch (n.operator) {
        case '+': return { value: a + b };
        case '-': return { value: a - b };
        case '*': return { value: a * b };
        case '/': return { value: a / b };
        case '%': return { value: a % b };
        case '**': return { value: a ** b };
        case '===': case '==': return { value: a === b };
        case '!==': case '!=': return { value: a !== b };
        case '<': return { value: a < b };
        case '>': return { value: a > b };
        case '<=': return { value: a <= b };
        case '>=': return { value: a >= b };
        case '|': return { value: a | b };
        case '&': return { value: a & b };
        default: return null;
        }
    }
    case 'LogicalExpression': {
        const l = tryConst(n.left);
        const r = tryConst(n.right);
        if (!l || !r) return null;
        if (n.operator === '&&') return { value: (l.value as any) && (r.value as any) };
        return { value: (l.value as any) || (r.value as any) };
    }
    case 'CallExpression': {
        const callee = n.callee;
        if (callee.type !== 'Identifier') return null;
        const args = n.arguments.map(tryConst);
        if (args.some((a: any) => !a)) return null;
        const av = args.map((a: any) => (a as any).value);
        switch (callee.name) {
        case 'Math.abs': return { value: Math.abs(av[0]) };
        case 'Math.sqrt': return { value: Math.sqrt(av[0]) };
        case 'Math.floor': return { value: Math.floor(av[0]) };
        case 'Math.ceil': return { value: Math.ceil(av[0]) };
        case 'Math.round': return { value: Math.round(av[0]) };
        case 'Math.exp': return { value: Math.exp(av[0]) };
        case 'Math.log': return { value: Math.log(av[0]) };
        case 'Math.sin': return { value: Math.sin(av[0]) };
        case 'Math.cos': return { value: Math.cos(av[0]) };
        case 'Math.tan': return { value: Math.tan(av[0]) };
        case 'toNotNaN': return { value: Number.isNaN(av[0]) ? 0 : av[0] };
        case 'toBoolean': return { value: toBoolean(av[0]) };
        default: return null;
        }
    }
    case 'MemberExpression': {
        if (n.object.type === 'Identifier' && n.object.name === 'Math' && n.property.type === 'Identifier') {
            if (n.property.name === 'PI') return { value: Math.PI };
            if (n.property.name === 'E') return { value: Math.E };
            if (n.property.name === 'LN10') return { value: Math.LN10 };
        }
        return null;
    }
    default:
        return null;
    }
}
