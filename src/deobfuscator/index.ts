/**
 * Deobfuscate a 02packager factory source back into a form the unwarp decompiler can
 * consume. Reverses the javascript-obfuscator transforms the packager applies to each
 * compiled script/procedure (see `wrapCompiledFactorySourceForObfuscation` +
 * `stringifyCompiledFactoryEval` in 02packager's packager.js):
 *
 *  1. unwrap `eval("<obfuscated>")` (the JSON-escaped string the packager stores);
 *  2. string-array decoding -- identify the array/decoder/wrapper chain, execute the
 *     decoder in a sandbox, and replace every decode call with its string literal;
 *  3. constant folding of the leftover `numbersToExpressions` / `splitStrings` output;
 *  4. extract the `(()=>{const X = function(thread){...}; return X;})()` factory and
 *     normalize `obj["prop"]` member access back to dot notation (except variable/list
 *     id lookups) so the decompiler's recognizers match.
 *
 * Executing the obfuscated code is inherent: the string-array rotation, base64 and rc4
 * encodings and per-call index arithmetic are only knowable at runtime. The packager
 * itself evals this code, so this runs it in a fresh function scope with no access to
 * this module's internals.
 */
import { parse } from 'acorn';
import type { Node, Program } from 'estree';
import { foldExpr, renderConst } from './fold';

interface Replacement {
    start: number;
    end: number;
    text: string;
}

interface FunctionDecl {
    name: string;
    params: string[];
    body: Node;
}

interface Scope {
    funcs: Map<string, FunctionDecl>;
    parent: Scope | null;
}

// ---------------------------------------------------------------------------
// eval-string unwrapping
// ---------------------------------------------------------------------------

/** `eval("...")` -> the inner JS. Non-eval input is returned unchanged. */
export function unwrapEvalSource(raw: string): string {
    const t = raw.trim();
    if (t.startsWith('eval(') && t.endsWith(')')) {
        const inner = t.slice(5, -1).trim();
        try {
            const parsed: unknown = JSON.parse(inner);
            if (typeof parsed === 'string') return parsed;
        } catch {
            // fall through to the loose fallback below
        }
        // Loose fallback: strip the surrounding quotes and unescape common sequences.
        if (inner.length >= 2 && (inner[0] === '"' || inner[0] === "'")) {
            try {
                return new Function(`return ${inner}`)();
            } catch {
                return inner.slice(1, -1);
            }
        }
        return inner;
    }
    return raw;
}

// ---------------------------------------------------------------------------
// scope / function collection
// ---------------------------------------------------------------------------

function isFunction(n: Node | null | undefined): boolean {
    return !!n && (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression');
}

interface ScopeTree {
    program: Scope;
    /** Scope in which each function body block executes (its own function scope). */
    scopeOf: Map<Node, Scope>;
}

/** Collect every named function with its declaring scope; record the scope of each function body. */
function buildScopes(root: Program): ScopeTree {
    const program: Scope = { funcs: new Map(), parent: null };
    const scopeOf = new Map<Node, Scope>();
    const register = (scope: Scope, fn: any, name: string): void => {
        if (!name) return;
        scope.funcs.set(name, {
            name,
            params: (fn.params ?? []).map((p: any) =>
                p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left?.type === 'Identifier' ? p.left.name : ''),
            body: fn.body,
        });
    };
    const walk = (node: any, scope: Scope): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration') {
            // function declarations are hoisted into the enclosing scope
            register(scope, node, node.id?.name);
            const child: Scope = { funcs: new Map(), parent: scope };
            if (node.id?.name) child.funcs.set(node.id.name, scope.funcs.get(node.id.name)!);
            scopeOf.set(node.body, child);
            walk(node.body, child);
            return;
        }
        if (node.type === 'FunctionExpression') {
            const child: Scope = { funcs: new Map(), parent: scope };
            if (node.id?.name) {
                // a named function expression binds its own name inside its body (recursion)
                child.funcs.set(node.id.name, {
                    name: node.id.name, params: (node.params ?? []).map((p: any) => p.name ?? ''),
                    body: node.body,
                });
            }
            scopeOf.set(node.body, child);
            walk(node.body, child);
            return;
        }
        if (node.type === 'ArrowFunctionExpression') {
            const child: Scope = { funcs: new Map(), parent: scope };
            scopeOf.set(node.body, child);
            walk(node.body, child);
            return;
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) for (const item of v) walk(item, scope);
            else if (v && typeof v === 'object') walk(v, scope);
        }
    };
    walk(root, program);
    return { program, scopeOf };
}

function lookupFunction(name: string, scope: Scope | null): FunctionDecl | null {
    for (let s: Scope | null = scope; s; s = s.parent) {
        const f = s.funcs.get(name);
        if (f) return f;
    }
    return null;
}

// ---------------------------------------------------------------------------
// string-array identification
// ---------------------------------------------------------------------------

/** The array function returns `[...]` via `const X = [...]; F = () => X; return F();`. */
function findArrayFunction(ast: Program): string | null {
    for (const stmt of ast.body) {
        if (stmt.type !== 'FunctionDeclaration') continue;
        const name = stmt.id?.name;
        if (!name) continue;
        const body = stmt.body;
        if (body.type !== 'BlockStatement') continue;
        let selfAssign = false;
        let selfCall = false;
        for (const s of body.body) {
            if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
                s.expression.left.type === 'Identifier' && s.expression.left.name === name &&
                isFunction(s.expression.right)) {
                selfAssign = true;
            }
            if (s.type === 'ReturnStatement' && s.argument?.type === 'CallExpression' &&
                s.argument.callee.type === 'Identifier' && s.argument.callee.name === name) {
                selfCall = true;
            }
        }
        if (selfAssign && selfCall) return name;
    }
    return null;
}

/** The decoder references the array function (`const A = arrFn();` after `idx = idx - N;`). */
function findDecoderFunction(ast: Program, arrayFn: string): string | null {
    for (const stmt of ast.body) {
        if (stmt.type !== 'FunctionDeclaration') continue;
        const name = stmt.id?.name;
        if (!name || name === arrayFn) continue;
        if (!refsFunction(stmt.body, arrayFn)) continue;
        // decoder's body starts by rebasing its first parameter: `x = x - <expr>;`
        const first = stmt.body.body[0];
        if (first?.type === 'ExpressionStatement' && first.expression.type === 'AssignmentExpression' &&
            first.expression.operator === '=' && first.expression.left.type === 'Identifier') {
            return name;
        }
    }
    return null;
}

function refsFunction(node: any, name: string): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return node.name === name;
    if (isFunction(node)) {
        // do not cross into nested function boundaries (wrappers call the decoder, not the array fn)
        for (const key of ['id']) {
            if (key in node) { /* skip */ }
        }
        let found = false;
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range' || key === 'id' || key === 'params' || key === 'body') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const item of v) if (refsFunction(item, name)) found = true; }
            else if (v && typeof v === 'object' && refsFunction(v, name)) found = true;
        }
        return found;
    }
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const item of v) if (refsFunction(item, name)) return true; }
        else if (v && typeof v === 'object' && refsFunction(v, name)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// factory extraction
// ---------------------------------------------------------------------------

/**
 * The packager wraps each factory as `(()=>{const __o2_factory_out__ = <fn>; return __o2_factory_out__;})()`.
 * javascript-obfuscator preserves that shape, so find the `<fn>` FunctionExpression.
 */
function findFactoryNode(ast: Program): Node | null {
    let found: Node | null = null;
    const walk = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && (node.callee.type === 'ArrowFunctionExpression' || node.callee.type === 'FunctionExpression')) {
            const body = node.callee.body;
            if (body.type === 'BlockStatement') {
                let fnExpr: any = null;
                let fnName: string | null = null;
                for (const stmt of body.body) {
                    if (stmt.type === 'VariableDeclaration') {
                        for (const d of stmt.declarations) {
                            if (d.id.type === 'Identifier' && d.init && isFunction(d.init) && d.init.type !== 'ArrowFunctionExpression') {
                                fnExpr = d.init;
                                fnName = d.id.name;
                            }
                        }
                    } else if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'Identifier' &&
                        fnName !== null && stmt.argument.name === fnName && fnExpr) {
                        found = fnExpr;
                    }
                }
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const item of v) walk(item); }
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(ast);
    return found;
}

/**
 * Find a bare top-level function (non-obfuscated factorySource like
 * `(function name(thread) { ... })` or `async function name(thread) { ... })`).
 * Returns the FunctionExpression / FunctionDeclaration node, or null.
 */
function findBareFactoryNode(ast: Program): Node | null {
    const body = (ast as any).body;
    if (!Array.isArray(body)) return null;
    for (const stmt of body) {
        if (stmt.type === 'FunctionDeclaration') return stmt;
        if (stmt.type === 'ExpressionStatement' && stmt.expression) {
            const e = stmt.expression;
            if (e.type === 'FunctionExpression') return e;
            // `(function name(thread){...})` — the function may be wrapped in parens
            if (e.type === 'SequenceExpression' && e.expressions) {
                for (const ex of e.expressions) {
                    if (ex.type === 'FunctionExpression') return ex;
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// object-literal constant collection (string-array "named" constants)
// ---------------------------------------------------------------------------

/**
 * javascript-obfuscator (with `stringArrayWrappersType: 'function'` + CFF) stores decoded
 * strings and the CFF order string as properties of a factory-scope object literal:
 * `const _0x4ca22c = { 'SZLkg': "3|1|0|2|4", 'IZvhh': "hi there" }`. Collect those
 * consts so `_0x4ca22c.IZvhh` can be inlined back to its literal value.
 * Returns objName -> { propName: literalValue }.
 */
interface ConstObjects {
    /** objName -> propName -> literal value (only props whose value resolved to a constant) */
    consts: Map<string, Map<string, string | number | boolean>>;
    /** objName -> propName -> function node, for pass-through helper wrappers like `{'QntPi': function(x){return x();}}` */
    wrappers: Map<string, Map<string, any>>;
}

function collectConstObjects(root: any): ConstObjects {
    const consts = new Map<string, Map<string, string | number | boolean>>();
    const wrappers = new Map<string, Map<string, any>>();
    // pending: objects with at least one unresolved (member-ref) value, kept as raw property nodes
    const pending = new Map<string, { key: string | null; value: any }[]>();
    const getMember = (v: any): string | number | boolean | undefined => {
        if (v.type === 'MemberExpression' && v.object.type === 'Identifier') {
            const obj = consts.get(v.object.name);
            if (!obj) return undefined;
            const key = v.property.type === 'Identifier' ? v.property.name
                : v.property.type === 'Literal' && typeof v.property.value === 'string' ? v.property.value : null;
            if (key === null) return undefined;
            const value = obj.get(key);
            return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
        }
        return undefined;
    };
    const tryValue = (v: any): string | number | boolean | undefined => {
        if (v.type === 'Literal' && (typeof v.value === 'string' || typeof v.value === 'number' || typeof v.value === 'boolean')) {
            return v.value;
        }
        if (v.type === 'TemplateLiteral' && v.expressions.length === 0 && v.quasis.length === 1) {
            return v.quasis[0].value.cooked as string;
        }
        const member = getMember(v);
        if (member !== undefined) return member;
        // a binary/unary leftover (e.g. `decode('..') + 're'`) whose operands are already
        // literals; fold it so the object const still resolves even outside the factory slice
        const folded = foldExpr(v);
        if (typeof folded === 'string' || typeof folded === 'number' || typeof folded === 'boolean') return folded;
        return undefined;
    };
    // javascript-obfuscator's `stringArrayWrappersType: 'function'` helpers take three shapes:
    //   pass-through    `function(x){return x();}`
    //   operator        `function(a,b){return a<b;}`  (wraps a comparison in a loop/if test)
    //   call-through    `function(x){function h(){...}return _0x..pnQsG(x);}` (chains to another wrapper)
    const isWrapperFn = (v: any): boolean => {
        if ((v.type !== 'FunctionExpression' && v.type !== 'ArrowFunctionExpression') || v.body.type !== 'BlockStatement') return false;
        const stmts = v.body.body;
        let ret: any = null;
        for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            if (s.type === 'FunctionDeclaration') continue; // dead helper helpers
            if (i === stmts.length - 1 && s.type === 'ReturnStatement') { ret = s.argument; break; }
            return false;
        }
        if (!ret) return false;
        return ret.type === 'CallExpression' || ret.type === 'BinaryExpression';
    };
    const walk = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'VariableDeclaration') {
            for (const d of node.declarations) {
                if (d.id.type !== 'Identifier' || !d.init) continue;
                const init = d.init;
                if (init.type === 'ObjectExpression') {
                    const props: { key: string | null; value: any }[] = [];
                    let allResolved = true;
                    for (const p of init.properties) {
                        if (p.type !== 'Property') continue;
                        const key = p.key.type === 'Identifier' ? p.key.name
                            : p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null;
                        if (key === null) { allResolved = false; continue; }
                        props.push({ key, value: p.value });
                        if (isWrapperFn(p.value)) {
                            if (!wrappers.has(d.id.name)) wrappers.set(d.id.name, new Map());
                            wrappers.get(d.id.name)!.set(key, p.value);
                        }
                        if (tryValue(p.value) === undefined) allResolved = false;
                    }
                    if (allResolved) {
                        const map = new Map<string, string | number | boolean>();
                        for (const p of props) {
                            if (p.key === null) continue;
                            const value = tryValue(p.value);
                            if (value !== undefined) map.set(p.key, value);
                        }
                        consts.set(d.id.name, map);
                    } else {
                        // collect the resolvable subset now; member-refs may resolve later
                        const map = new Map<string, string | number | boolean>();
                        for (const p of props) {
                            if (p.key === null) continue;
                            const value = tryValue(p.value);
                            if (value !== undefined) map.set(p.key, value);
                        }
                        consts.set(d.id.name, map);
                        pending.set(d.id.name, props);
                    }
                } else if (init.type === 'Literal' && typeof init.value === 'string') {
                    consts.set(d.id.name, new Map([['__self__', init.value]]));
                }
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(root);
    // resolve nested member references to a fixpoint (e.g. `{'o': B.order}` where B is known later)
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, props] of pending) {
            const map = consts.get(name);
            if (!map) continue;
            let grown = false;
            for (const p of props) {
                if (p.key === null || map.has(p.key)) continue;
                const value = tryValue(p.value);
                if (value !== undefined) { map.set(p.key, value); grown = true; }
            }
            if (grown) changed = true;
        }
    }
                    return { consts, wrappers };
}

/** Resolve `obj.prop` / `obj["prop"]` against collected const objects; null if unknown. */
function resolveConstMember(node: any, constObjects: ConstObjects): any {
    if (!node || node.type !== 'MemberExpression' || node.object.type !== 'Identifier') return undefined;
    const obj = constObjects.consts.get(node.object.name);
    if (!obj) return undefined;
    const key = node.property.type === 'Identifier' ? node.property.name
        : node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null;
    if (key === null) return undefined;
    const value = obj.get(key);
    if (value === undefined && key !== '__self__') {
        // a member whose value is a nested const object reference we can't resolve
        return undefined;
    }
    return value;
}

/**
 * Rewrite a wrapper call like `_0x31f8e1.QntPi(retire)` / `_0x3f29f4.ghCoV(a,b)` /
 * `_0xc244fa.MMDGc(f,x,y)` back to the wrapped invocation. javascript-obfuscator
 * (`stringArrayWrappersType: 'function'`) emits helpers of three shapes stored as object
 * members:
 *   pass-through    `function(x){return x();}`                     -> `arg0()`
 *   operator        `function(a,b){return a<b;}`                  -> `arg0<arg1`
 *   call-through    `function(x){...return _0x..pnQsG(x);}`       -> resolved chain
 * Call-through bodies reference other wrapper objects; they are resolved recursively.
 * Returns replacement text for the whole call node, or null when not a wrapper call.
 */
function tryRewriteWrapperCall(call: any, constObjects: ConstObjects, js: string): string | null {
    const callee = call.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null;
    const key = callee.property.type === 'Identifier' ? callee.property.name
        : callee.property.type === 'Literal' && typeof callee.property.value === 'string' ? callee.property.value : null;
    if (key === null) return null;
    const argTexts: (string | null)[] = call.arguments.map((a: any) => renderArg(a, constObjects, js));
    if (argTexts.some((t) => t === null)) return null;
    return resolveWrapperCall(callee.object.name, key, argTexts as string[], constObjects, js, 0);
}

/** Resolve `objName.key(argTexts)` through the wrapper map, following call-through chains. */
function resolveWrapperCall(
    objName: string,
    key: string,
    argTexts: string[],
    constObjects: ConstObjects,
    js: string,
    depth: number,
): string | null {
    if (depth > 8) return null;
    const fns = constObjects.wrappers.get(objName);
    if (!fns) return null;
    const fn = fns.get(key);
    if (!fn) return null;
    const params: (string | null)[] = fn.params.map((p: any) => (p.type === 'Identifier' ? p.name : null));
    if (params.some((p) => p === null)) return null;
    // find the trailing return statement (skip leading helper function declarations)
    let ret: any = null;
    for (const s of fn.body.body) {
        if (s.type === 'FunctionDeclaration') continue;
        if (s.type === 'ReturnStatement') { ret = s.argument; break; }
    }
    if (!ret) return null;
    const paramToArg = (name: string): string | null => {
        const i = params.indexOf(name);
        return i >= 0 && i < argTexts.length ? argTexts[i] : null;
    };
    const rendered = renderWrapperExpr(ret, paramToArg, constObjects, js, depth);
    if (rendered === null) return null;
    // Parenthesize the inlined body. The call may sit in any precedence context (e.g.
    // `!wrapper(a,b)` where the body is `a===b`); splicing the body text in verbatim would
    // let an enclosing prefix operator bind to the wrong operand. Extra parens around an
    // expression never change its meaning.
    return `(${rendered})`;
}

/** Render a wrapper-body expression to text, substituting params with their arg text. */
function renderWrapperExpr(
    node: any,
    paramToArg: (name: string) => string | null,
    constObjects: ConstObjects,
    js: string,
    depth: number,
): string | null {
    if (depth > 8) return null;
    if (!node) return null;
    switch (node.type) {
        case 'Identifier': {
            const sub = paramToArg(node.name);
            if (sub !== null) return sub;
            return node.name; // a free variable (e.g. a module-level helper ref) is kept verbatim
        }
        case 'Literal':
            return renderConst(node.value as any);
        case 'TemplateLiteral':
            if (node.expressions.length === 0 && node.quasis.length === 1) return renderConst(node.quasis[0].value.cooked as any);
            return null;
        case 'UnaryExpression': {
            const a = renderWrapperExpr(node.argument, paramToArg, constObjects, js, depth + 1);
            if (a === null) return null;
            return `${node.operator}${a}`;
        }
        case 'BinaryExpression':
        case 'LogicalExpression': {
            const l = renderWrapperExpr(node.left, paramToArg, constObjects, js, depth + 1);
            const r = renderWrapperExpr(node.right, paramToArg, constObjects, js, depth + 1);
            if (l === null || r === null) return null;
            return `(${l})${node.operator}(${r})`;
        }
        case 'CallExpression': {
            if (node.callee.type === 'Identifier') {
                const head = paramToArg(node.callee.name);
                if (head === null) return null;
                const args: string[] = [];
                for (const a of node.arguments) {
                    const t = renderWrapperExpr(a, paramToArg, constObjects, js, depth + 1);
                    if (t === null) return null;
                    args.push(t);
                }
                return `${head}(${args.join(',')})`;
            }
            if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier') {
                const prop = node.callee.property.type === 'Identifier' ? node.callee.property.name
                    : node.callee.property.type === 'Literal' && typeof node.callee.property.value === 'string' ? node.callee.property.value : null;
                if (prop === null) return null;
                const args: string[] = [];
                for (const a of node.arguments) {
                    const t = renderWrapperExpr(a, paramToArg, constObjects, js, depth + 1);
                    if (t === null) return null;
                    args.push(t);
                }
                return resolveWrapperCall(node.callee.object.name, prop, args, constObjects, js, depth + 1);
            }
            return null;
        }
        default:
            return null;
    }
}

/** Render a call argument to (post-decode) source text for wrapper-call rewriting. */
function renderArg(a: any, constObjects: ConstObjects, js: string): string | null {
    const folded = foldExpr(a);
    if (folded !== undefined && typeof folded !== 'object') return renderConst(folded as any);
    const member = resolveConstMember(a, constObjects);
    if (member !== undefined) return renderConst(member);
    if (a.type === 'Identifier') return a.name;
    if (a.type === 'Literal' && typeof a.value !== 'object') return renderConst(a.value);
    // render a member expression from the (post-decode) AST so decoded keys survive,
    // instead of slicing the raw source (which would re-introduce decode calls).
    if (a.type === 'MemberExpression') {
        const obj = renderArg(a.object, constObjects, js);
        if (obj === null) return null;
        if (a.computed && a.property.type === 'Literal' && typeof a.property.value === 'string') {
            return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(a.property.value) ? `${obj}.${a.property.value}` : `${obj}[${renderConst(a.property.value)}]`;
        }
        if (a.property.type === 'Identifier') return `${obj}.${a.property.name}`;
        const p = renderArg(a.property, constObjects, js);
        return p === null ? null : `${obj}[${p}]`;
    }
    // render a call expression from the (post-decode) AST (e.g. `_0x2535d3[k][k2]()`),
    // keeping decoded member keys instead of re-slicing the raw source span.
    if (a.type === 'CallExpression') {
        if (a.callee.type === 'MemberExpression' && a.callee.object.type === 'Identifier') {
            const wrapped = tryRewriteWrapperCall(a, constObjects, js);
            if (wrapped !== null) return wrapped;
        }
        const callee = renderArg(a.callee, constObjects, js);
        if (callee === null) return null;
        const args: string[] = [];
        for (const arg of a.arguments) {
            const t = renderArg(arg, constObjects, js);
            if (t === null) return null;
            args.push(t);
        }
        return `${callee}(${args.join(',')})`;
    }
    // fall back to the original source span (e.g. `_0x1aaf7f.timer.timeElapsed()`)
    if (typeof a.start === 'number' && typeof a.end === 'number') {
        return js.slice(a.start, a.end);
    }
    return null;
}

// ---------------------------------------------------------------------------
// control-flow flattening reversal
// ---------------------------------------------------------------------------

/**
 * javascript-obfuscator's control-flow flattening rewrites a function body into:
 *   const <order> = "<a|b|c...>".split('|');
 *   let <i> = 0;
 *   while (true) { switch (<order>[<i>++]) { case '0': <stmt>; continue; ... } break; }
 * Reconstruct the original statement order from the order string and emit the case
 * bodies in that order (dropping the dispatcher's `continue`/`break` scaffolding).
 * Returns a source range -> ordered statement text replacement, or null if not a match.
 */
function reverseControlFlow(
    ast: Program,
    js: string,
    factoryStart: number,
    factoryEnd: number,
    constObjects: ConstObjects,
): Replacement[] {
    const reps: Replacement[] = [];
    const walk = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression' || node.type === 'WhileStatement' || node.type === 'BlockStatement') {
            const r = tryReverseBody(node, js, factoryStart, factoryEnd, constObjects);
            if (r) reps.push(r);
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(ast);
    return reps;
}

function tryReverseBody(
    fn: any,
    js: string,
    factoryStart: number,
    factoryEnd: number,
    constObjects: ConstObjects,
): Replacement | null {
    const body = fn.type === 'BlockStatement' ? fn : fn.body;
    if (!body || body.type !== 'BlockStatement') return null;
    const stmts = body.body;
    if (!Array.isArray(stmts)) return null;

    // 1. locate the order-array declaration and the counter init
    let orderVar: string | null = null;
    let orderExpr: any = null;
    let orderDeclIndex = -1;
    let idxVar: string | null = null;
    for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (s.type !== 'VariableDeclaration') continue;
        for (const d of s.declarations) {
            if (d.id.type !== 'Identifier' || !d.init) continue;
            const init = d.init;
            // <stringExpr>.split('|')
            if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
                !init.callee.computed && init.callee.property.type === 'Identifier' &&
                init.callee.property.name === 'split' && init.arguments.length === 1 &&
                init.arguments[0].type === 'Literal' && init.arguments[0].value === '|') {
                orderVar = d.id.name;
                orderExpr = init.callee.object;
                orderDeclIndex = i;
                continue;
            }
            // <orderVar> = <stringExpr>['split']('|') with computed split
            if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
                init.callee.computed && init.callee.property.type === 'Literal' &&
                init.callee.property.value === 'split' && init.arguments.length === 1 &&
                init.arguments[0].type === 'Literal' && init.arguments[0].value === '|') {
                orderVar = d.id.name;
                orderExpr = init.callee.object;
                orderDeclIndex = i;
            }
        }
    }
    if (!orderVar || !orderExpr || orderDeclIndex === -1) {
        return null;
    }

    // 2. resolve the order string
    const orderString = resolveOrderExpr(orderExpr, constObjects);
    if (orderString === null) return null;
    const order = orderString.split('|');
    if (order.length === 0) return null;

    // 3. find the counter init and the while-switch
    let idxDeclIndex = -1;
    for (let i = orderDeclIndex; i < stmts.length; i++) {
        const s = stmts[i];
        if (s.type === 'VariableDeclaration') {
            for (const d of s.declarations) {
                if (d.id.type === 'Identifier' && d.id.name !== orderVar) {
                    idxVar = d.id.name;
                    idxDeclIndex = i;
                }
            }
            if (idxVar) break;
        }
    }
    let whileIndex = -1;
    for (let i = idxDeclIndex >= 0 ? idxDeclIndex : orderDeclIndex; i < stmts.length; i++) {
        if (stmts[i].type === 'WhileStatement') { whileIndex = i; break; }
    }
    if (whileIndex === -1) return null;
    const whileNode = stmts[whileIndex];

    // 4. parse the switch cases
    const cases = new Map<string, any[]>();
    const discr = whileNode.test;
    let isTrueLoop = false;
    if (discr.type === 'Literal' && discr.value === true) isTrueLoop = true;
    else { const t = foldExpr(discr); if (t === true) isTrueLoop = true; }
    if (!isTrueLoop) return null;

    const whileBody = whileNode.body;
    if (whileBody.type !== 'BlockStatement') return null;
    const switchStmt = whileBody.body.find((s: any) => s.type === 'SwitchStatement');
    if (!switchStmt) return null;
    for (const c of switchStmt.cases) {
        if (c.test && c.test.type === 'Literal' && typeof c.test.value === 'string') {
            cases.set(c.test.value, c.consequent);
        }
    }

    // 5. emit case bodies in order; strip the dispatcher's trailing `continue`
    const pieces: string[] = [];
    for (let oi = 0; oi < order.length; oi++) {
        const label = order[oi];
        const body = cases.get(label);
        if (!body || body.length === 0) continue;
        const last = body[body.length - 1];
        const stmtsToEmit = last.type === 'ContinueStatement' ? body.slice(0, -1) : body;
        if (stmtsToEmit.length === 0) continue;
        for (const s of stmtsToEmit) {
            if (s.start >= factoryStart && s.end <= factoryEnd) {
                pieces.push(js.slice(s.start, s.end).replace(/;?\s*$/, '') + ';');
            }
        }
    }
    if (pieces.length === 0) return null;
    if (process.env.DEBUG_CFF) {
        console.error(`[DEBUG_CFF] emitted order of case labels: ${order.map(l => cases.get(l) ? l : l + '?').join(',')}`);
    }

    // 6. replace from the order declaration through the while loop with the ordered statements
    const start = stmts[orderDeclIndex].start;
    const end = whileNode.end;
    return { start, end, text: pieces.join('') };
}

function resolveOrderExpr(expr: any, constObjects: ConstObjects): string | null {
    // literal
    if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
    // object-const member
    const member = resolveConstMember(expr, constObjects);
    if (member !== undefined && typeof member === 'string') return member;
    // foldable concat of chunks (`"a" + "b"`)
    const folded = foldExpr(expr);
    if (typeof folded === 'string') return folded;
    return null;
}

// ---------------------------------------------------------------------------
// decode call resolution
// ---------------------------------------------------------------------------

/** Substitute param names for literal values in an expression, then fold to a constant. */
function substituteAndFold(expr: Node, params: string[], values: unknown[]): unknown {
    const copy = (n: any): any => {
        if (!n || typeof n !== 'object') return n;
        if (n.type === 'Identifier') {
            const i = params.indexOf(n.name);
            if (i >= 0) {
                const v = values[i];
                return { type: 'Literal', value: v, start: n.start, end: n.end };
            }
        }
        const o: any = { type: n.type, start: n.start, end: n.end };
        for (const k of Object.keys(n)) {
            if (k === 'loc' || k === 'range') continue;
            const v = n[k];
            if (Array.isArray(v)) o[k] = v.map(copy);
            else if (v && typeof v === 'object') o[k] = copy(v);
            else o[k] = v;
        }
        return o;
    };
    return foldExpr(copy(expr));
}

// ---------------------------------------------------------------------------
// main pass
// ---------------------------------------------------------------------------

export interface DeobfuscateResult {
    /** Cleaned factory source (anonymous or named `function(thread) {...}`), parenthesized. */
    source: string;
    /** True when the string-array was successfully decoded. */
    decoded: boolean;
    /** True when the factory IIFE was located and extracted. */
    factoryFound: boolean;
}

/**
 * Expand comma expressions back into separate statements.
 *
 * javascript-obfuscator collapses a run of expression statements into one comma expression, so
 * an entire script body can arrive as `return a(), b(), '';` -- a single ReturnStatement. The
 * decompiler would see one block instead of the script, so the sequence is split back out:
 *   `return x, y;`  ->  `x; y; return ;`  (the trailing value stays as the return argument)
 *   `(x, y);`       ->  `x; y;`
 *
 * Only sequences in statement position are touched; a comma expression inside a condition, a
 * call argument or a `for` header is genuine and must survive untouched. A sequence may also
 * carry a function *expression*, which is not a valid statement -- so each rewrite is verified
 * by re-parsing and abandoned if it would not compile.
 */
function splitSequences(js: string): string {
    const parseOpts = { ecmaVersion: 'latest' as const, allowReturnOutsideFunction: true };

    for (let guard = 0; guard < 24; guard++) {
        let ast: any;
        try {
            ast = parse(js, parseOpts);
        } catch {
            return js;
        }

        const reps: Replacement[] = [];
        const emit = (parts: string[], tail: string) =>
            parts.map(p => `${p};`).join('') + `${tail};`;

        // Only sequences in *statement* position may be split. A sequence inside a condition,
        // a call argument or a `for` header is a genuine comma expression, and turning it into
        // statements there would not parse.
        const walk = (node: any): void => {
            if (!node || typeof node !== 'object') return;

            if (node.type === 'ReturnStatement' && node.argument && node.argument.type === 'SequenceExpression') {
                const parts = node.argument.expressions.map((e: any) => js.slice(e.start, e.end));
                if (parts.length > 1) {
                    const last = parts.pop()!;
                    reps.push({ start: node.start, end: node.end, text: `${emit(parts, '')}return ${last};` });
                    // note: emit already terminated every leading part with ';'
                }
            } else if (node.type === 'ExpressionStatement' && node.expression.type === 'SequenceExpression') {
                const parts = node.expression.expressions.map((e: any) => js.slice(e.start, e.end));
                if (parts.length > 1) {
                    const last = parts.pop()!;
                    reps.push({ start: node.start, end: node.end, text: emit(parts, last) });
                }
            }

            for (const k of Object.keys(node)) {
                if (k === 'loc' || k === 'range') continue;
                const v = node[k];
                if (Array.isArray(v)) { for (const item of v) walk(item); }
                else if (v && typeof v === 'object') walk(v);
            }
        };
        walk(ast);

        if (!reps.length) return js;
        const deduped: Replacement[] = [];
        for (const r of reps.sort((a, b) => a.start - b.start)) {
            const prev = deduped[deduped.length - 1];
            if (prev && r.start < prev.end) continue; // keep the outermost
            deduped.push(r);
        }
        let out = js;
        for (const r of deduped.sort((a, b) => b.start - a.start)) {
            out = out.slice(0, r.start) + r.text + out.slice(r.end);
        }
        if (out === js) return js;
        // A sequence can contain a function *expression* or other construct that is not a valid
        // statement on its own; if the rewritten text no longer parses, abandon this pass and
        // keep what we had -- a conservative no-op beats producing unparseable code.
        try {
            parse(out, parseOpts);
        } catch {
            return js;
        }
        js = out;
    }
    return js;
}

/**
 * Deobfuscate one factory source. Returns the cleaned factory function source that can be
 * passed to `decompileScript`. On failure (unsupported obfuscation), returns the raw
 * unwrapped eval body unchanged so the caller can surface an error gracefully.
 */
export function deobfuscateFactorySource(raw: string): DeobfuscateResult {
    const js = unwrapEvalSource(raw);
    let ast: Program;
    try {
        ast = parse(js, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }) as Program;
    } catch {
        return { source: js, decoded: false, factoryFound: false };
    }

    const arrayFn = findArrayFunction(ast);
    const decoderName = arrayFn ? findDecoderFunction(ast, arrayFn) : null;
    let decoder: ((...args: any[]) => any) | null = null;
    if (decoderName) {
        try {
            decoder = new Function(`${js}\n;return ${decoderName};`)();
        } catch {
            decoder = null;
        }
    }

    const factory = findFactoryNode(ast);
    // If no IIFE wrapper found (non-obfuscated factorySource is a bare function expression),
    // fall back to the top-level function node.
    const factoryOrBare = factory ?? findBareFactoryNode(ast);
    const factoryStart = factoryOrBare ? (factoryOrBare as any).start : 0;
    const factoryEnd = factoryOrBare ? (factoryOrBare as any).end : js.length;
    const decoded = !!decoder;

    const reps: Replacement[] = [];
    const seen = new Set<string>();
    const record = (r: Replacement): void => {
        if (r.start < factoryStart || r.end > factoryEnd) return;
        const key = `${r.start}:${r.end}`;
        if (seen.has(key)) return;
        seen.add(key);
        // Keep tokens from gluing together. The obfuscator legally writes `case-0xb17*0x3:`
        // (the `-` separates the keyword from the value); once that folds to `1` the text would
        // become `case1:` -- a single identifier -- and the script would no longer parse.
        const isIdentChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch);
        let text = r.text;
        if (text && isIdentChar(js[r.start - 1]) && isIdentChar(text[0])) text = ' ' + text;
        if (text && isIdentChar(text[text.length - 1]) && isIdentChar(js[r.end])) text += ' ';
        reps.push({ start: r.start, end: r.end, text });
    };

    // 1) replace decode call sites with string literals
    const { program: rootScope, scopeOf } = buildScopes(ast);
    const walkDecode = (node: any, scope: Scope): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {

        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && decoder) {
            let argVals = node.arguments.map((a: any) => foldExpr(a));
            if (argVals.every((v: any) => v !== undefined)) {
                let calleeName = node.callee.name;
                let steps = 0;
                let value: unknown;
                while (steps++ < 16) {
                    if (calleeName === decoderName) {
                        value = decoder(...argVals);
                        break;
                    }
                    const decl = lookupFunction(calleeName, scope);
                    if (!decl) break;
                    const b = decl.body as any;
                    if (b.type !== 'BlockStatement' || b.body.length !== 1 || b.body[0].type !== 'ReturnStatement') break;
                    const ret = b.body[0].argument;
                    if (!ret || ret.type !== 'CallExpression' || ret.callee.type !== 'Identifier') break;
                    const sub = ret.arguments.map((e: any) => substituteAndFold(e, decl.params, argVals));
                    if (sub.some((v: any) => v === undefined)) break;
                    argVals = sub;
                    calleeName = ret.callee.name;
                }
                if (steps > 0 && calleeName === decoderName && value !== undefined) {
                    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                        node.type = 'Literal';
                        node.value = value;
                        delete node.callee;
                        delete node.arguments;
                        record({ start: node.start, end: node.end, text: renderConst(value as any) });
                    }
                }
            }
        }
        if (isFunction(node)) {
            // enter the scope recorded for this function's body (hoisted declarations included)
            walkDecode(node.body, scopeOf.get(node.body) ?? scope);
            return;
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const item of v) walkDecode(item, scope); }
            else if (v && typeof v === 'object') walkDecode(v, scope);
        }
    };
    walkDecode(ast, rootScope);

    // 2) constant folding (numbersToExpressions / splitStrings leftovers)
    const walkFold = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if ((node.type === 'BinaryExpression' || node.type === 'UnaryExpression' || node.type === 'LogicalExpression') &&
            node.start >= factoryStart && node.end <= factoryEnd) {
            const v = foldExpr(node);
            if (v !== undefined && typeof v !== 'object') {
                node.type = 'Literal';
                node.value = v;
                delete node.operator;
                delete node.left;
                delete node.right;
                delete node.argument;
                record({ start: node.start, end: node.end, text: renderConst(v as any) });
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const item of v) walkFold(item); }
            else if (v && typeof v === 'object') walkFold(v);
        }
    };
    walkFold(ast);

    // 1b) inline string-array object constants (`_0x4ca22c.IZvhh` -> "hi there").
    //     Collected after decode+fold so values that are folded binaries resolve to literals.
    const constObjects = collectConstObjects(ast);
    const walkObjConst = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'MemberExpression' && node.object.type === 'Identifier' &&
            ((!node.computed && (node.property.type === 'Identifier' ||
                (node.property.type === 'Literal' && typeof node.property.value === 'string'))) ||
                (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string')) &&
            node.start >= factoryStart && node.end <= factoryEnd) {
            const v = resolveConstMember(node, constObjects);
            if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
                record({ start: node.start, end: node.end, text: renderConst(v as any) });
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walkObjConst);
            else if (v && typeof v === 'object') walkObjConst(v);
        }
    };
    walkObjConst(ast);

    // 1c) rewrite pass-through wrapper calls (`_0x31f8e1.QntPi(retire)` -> `retire()`)
    const walkWrapper = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
            node.start >= factoryStart && node.end <= factoryEnd) {
            const text = tryRewriteWrapperCall(node, constObjects, js);
            if (text !== null) {
                record({ start: node.start, end: node.end, text });
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walkWrapper);
            else if (v && typeof v === 'object') walkWrapper(v);
        }
    };
    walkWrapper(ast);

    // 3) normalize `obj["prop"]` -> `obj.prop` (keep var/list id lookups computed).
    //    Replace only the `["prop"]` bracket (starting at the `[`), NOT from obj.end, so that a
    //    parenthesized object like `("a"+"b")["split"]` keeps its closing paren.
    const walkDot = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' &&
            typeof node.property.value === 'string' &&
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.property.value) &&
            node.start >= factoryStart && node.end <= factoryEnd) {
            const obj = node.object;
            let keepComputed = false;
            if (obj.type === 'MemberExpression') {
                const op = obj.property;
                const name = op.type === 'Identifier' ? op.name
                    : op.type === 'Literal' && typeof op.value === 'string' ? op.value : null;
                if (name === 'variables' || name === 'lists') keepComputed = true;
            }
            if (!keepComputed) {
                // find the `[` that opens the bracket (scan back from the property)
                let b = node.property.start - 1;
                while (b > obj.end && (js[b] === ' ' || js[b] === '\n' || js[b] === '\t')) b--;
                if (b >= obj.end) {
                    record({ start: b, end: node.end, text: `.${node.property.value}` });
                }
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            const v = node[key];
            if (Array.isArray(v)) { for (const item of v) walkDot(item); }
            else if (v && typeof v === 'object') walkDot(v);
        }
    };
    walkDot(ast);

    // 4) slice the factory and apply replacements. Overlapping edits (a decode call nested
    //    inside a member expression that is later dotted, or a split-string binary that wraps
    //    a decode call) collapse to the outermost one, which subsumes the inner text;
    //    offsets are then applied descending so earlier positions stay valid.
    let source = js.slice(factoryStart, factoryEnd);
    const deduped: Replacement[] = [];

    for (const r of reps.sort((a, b) => a.start - b.start)) {
        const prev = deduped[deduped.length - 1];
        if (prev && r.start < prev.end) {
            // overlapping: keep the wider (outermost) replacement
            if (r.end - r.start > prev.end - prev.start) deduped[deduped.length - 1] = r;
            continue;
        }
        deduped.push(r);
    }

    for (const r of deduped.sort((a, b) => b.start - a.start)) {
        const s = r.start - factoryStart;
        const e = r.end - factoryStart;
        source = source.slice(0, s) + r.text + source.slice(e);
    }

    // 4b) expand comma expressions back into statements (see splitSequences).
    source = splitSequences(source);

    // 5) reverse control-flow flattening on the decoded factory text. Runs here (phase 2)
    //    because the dispatcher case bodies must already be decoded: their text is spliced
    //    into the result, so any raw obfuscated forms inside them would survive otherwise.
    //    Dispatchers can nest (a flattened body whose case contains a flattened loop), so we
    //    keep the INNERMOST replacement each pass and iterate to a fixpoint: the outer body is
    //    re-parsed next iteration with its case text already de-flattened.
    for (let guard = 0; guard < 24; guard++) {
        const cff = (() => {
            try {
                const ast2 = parse(source, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }) as Program;
                return reverseControlFlow(ast2, source, 0, source.length, collectConstObjects(ast2));
            } catch (e: any) {
                return [];
            }
        })();
        if (!cff.length) break;
        const deduped2: Replacement[] = [];
        for (const r of cff.sort((a, b) => a.start - b.start)) {
            const prev = deduped2[deduped2.length - 1];
            if (prev && r.start < prev.end) {
                // overlapping: keep the innermost (smallest) so nested dispatchers
                // (a flattened loop inside a flattened body) unroll inside-out.
                if (r.end - r.start < prev.end - prev.start) deduped2[deduped2.length - 1] = r;
                continue;
            }
            deduped2.push(r);
        }
        for (const r of deduped2.sort((a, b) => b.start - a.start)) {
            source = source.slice(0, r.start) + r.text + source.slice(r.end);
        }
    }

    return {
        source: `(${source})`,
        decoded,
        factoryFound: !!(factory || factoryOrBare),
    };
}

export { foldExpr, renderConst };
