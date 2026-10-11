/**
 * Helpers to build realistic jsgen-style factory source strings for tests.
 * These mirror the output shape of scratch-vm/src/compiler/jsgen.js.
 */
export function factory(
    body: string,
    opts: { gen?: boolean; params?: string[]; setup?: string } = {},
): string {
    const gen = opts.gen ?? true;
    const params = opts.params ?? [];
    const setup = opts.setup ?? 'const b0 = target.variables["V1"];';
    return `(function factory0(thread) {
const target = thread.target;
const runtime = target.runtime;
const stage = runtime.getTargetForStage();
${setup}
return function${gen ? '*' : ''} gen0(${params.join(',')}) {
${body}
};
})`;
}
