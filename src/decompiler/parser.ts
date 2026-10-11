import { parse } from 'acorn';
import type { Node, Program } from 'estree';
import type { DecompileContext } from './types';
import { ASTNode, DecompileError } from './types';

export interface ParsedFactory {
    innerName: string | null;
    params: string[];
    isGenerator: boolean;
    body: Node; // BlockStatement
    setupConsts: Map<string, Node>;
    /** Name the factory's own first parameter goes by (obfuscated code renames `thread`). */
    threadParam: string;
    targetVar: string;
    runtimeVar: string;
    stageVar: string;
}

/** Identifier or string-literal member property name. */
function memberName(p: any): string | null {
    if (!p) return null;
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
    return null;
}

function findFactory(ast: Program): Node {
    for (const stmt of ast.body) {
        if (stmt.type === 'ReturnStatement' && stmt.argument && isFunction(stmt.argument)) {
            return stmt.argument;
        }
        if (stmt.type === 'ExpressionStatement' && isFunction(stmt.expression)) {
            return stmt.expression;
        }
        if (isFunction(stmt)) {
            return stmt;
        }
    }
    throw new DecompileError('could not locate a factory function in the source');
}

function isFunction(n: Node | null | undefined): boolean {
    return !!n && (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
}

function paramName(p: Node): string {
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') return p.left.name;
    return 'p?';
}

/**
 * Parse the factory-source string produced by scratch-vm's jsgen and extract:
 *  - the inner script function (name, params, generator flag, body)
 *  - the hoisted setup consts (jsgen's evaluateOnce: `const b0 = target.variables["id"]`)
 */
export function parseFactorySource(source: string): ParsedFactory {
    const ast = parse(source, {
        ecmaVersion: 'latest',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
    }) as Program;

    const factory = findFactory(ast);
    const factoryNode = factory as any;
    const threadParam = factoryNode.params?.[0]?.type === 'Identifier' ? factoryNode.params[0].name
        : factoryNode.params?.[0]?.type === 'AssignmentPattern' && factoryNode.params[0].left?.type === 'Identifier'
            ? factoryNode.params[0].left.name : null;
    const setupConsts = new Map<string, Node>();
    let targetVar = 'target';
    let runtimeVar = 'runtime';
    let stageVar = 'stage';
    let inner: Node | null = null;

    const body = factoryNode.body;
    if (!body || body.type !== 'BlockStatement') {
        throw new DecompileError('factory function has no block body');
    }

    const isMemberOf = (node: Node, baseName: string, prop: string): boolean =>
        node.type === 'MemberExpression' && node.object.type === 'Identifier' &&
        node.object.name === baseName && memberName(node.property) === prop;

    for (const stmt of body.body) {
        if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
                if (d.id.type !== 'Identifier') continue;
                const init = d.init;
                if (init) {
                    if (isMemberOf(init, threadParam ?? '', 'target')) {
                        targetVar = d.id.name;
                        continue;
                    }
                    if (isMemberOf(init, targetVar, 'runtime')) {
                        runtimeVar = d.id.name;
                        continue;
                    }
                    if (isMemberOf(init, runtimeVar, 'getTargetForStage')) {
                        stageVar = d.id.name;
                        continue;
                    }
                    // `const stage = <runtimeVar>.getTargetForStage()` (jsgen form, incl. obfuscated renames).
                    if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' &&
                        init.callee.object.type === 'Identifier' && init.callee.object.name === runtimeVar &&
                        memberName(init.callee.property) === 'getTargetForStage') {
                        stageVar = d.id.name;
                        continue;
                    }
                }
                // generic hoisted const: `const b0 = <expr>`
                setupConsts.set(d.id.name, init ?? null);
            }
        } else if (stmt.type === 'ReturnStatement' && stmt.argument && isFunction(stmt.argument)) {
            inner = stmt.argument;
            break;
        }
    }

    if (!inner) {
        throw new DecompileError('factory function does not return a script function');
    }

    const innerFn = inner as any;
    const params: string[] = (innerFn.params ?? []).map(paramName);
    const isGenerator = !!innerFn.generator;
    const innerName = innerFn.id?.name ?? null;

    const ctx: DecompileContext = { setupConsts, params, targetVar, stageVar, runtimeVar, threadParam };

    return { innerName, params, isGenerator, body: innerFn.body, setupConsts: ctx.setupConsts, threadParam, targetVar, runtimeVar, stageVar };
}
