/**
 * Shared round-trip harness: drive the REAL scratch-vm code generator (irgen is bypassed by
 * constructing the native IntermediateScript directly; jsgen is the deterministic inverse
 * of irgen, so decompile(jsgen(nativeIR)) reconstructing nativeIR proves the decompiler
 * inverts jsgen exactly). This catches any mismatch between our recognizers and jsgen's
 * actual emission, which unit fixtures alone cannot guarantee.
 *
 * scratch-vm is only needed to run jsgen; if it is not resolvable the suites skip silently
 * rather than failing (the per-recognizer unit tests still cover shape).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompileScript } from '../src/decompiler/index';

// Resolve the local scratch-vm compiler. Absolute path in this workspace; falls back to package.
// Set UNWARP_VM=/path/to/vm/src to run the same suite against a different compiler build
// (e.g. 02scratch-vm, whose jsgen diverges from upstream and is what unwarp must invert).
const VM_CANDIDATES = [
  process.env.UNWARP_VM,
  '/home/neuronpulse/unwarp/scratch-vm/src',
].filter(Boolean) as string[];

let VM: any = null;
for (const candidate of VM_CANDIDATES) {
  try {
    require(candidate as string);
    VM = candidate;
    break;
  } catch { /* try next */ }
}
if (!VM) {
  try { require.resolve('scratch-vm'); VM = 'scratch-vm/src'; } catch { VM = null; }
}

export let JSG: any = null;
export let INTER: any = null;
export let ENUMS: any = null;
export let BLOCKTYPE: any = null;
if (VM) {
  try {
    JSG = require(VM + '/compiler/jsgen');
    INTER = require(VM + '/compiler/intermediate');
    ENUMS = require(VM + '/compiler/enums');
    BLOCKTYPE = require(VM + '/extension-support/block-type');
    (JSG as any).testingApparatus = { report: (_g: any, f: string) => { lastSource = f; } };
  } catch {
    JSG = INTER = ENUMS = BLOCKTYPE = null;
  }
}

let lastSource = '';

const EFFECTS = { color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: 0, ghost: 0 };

export interface RtOptions {
  warp?: boolean;
  yields?: boolean;
  isStage?: boolean;
  isProcedure?: boolean;
  args?: string[];
  procedures?: Record<string, any>;
  /** Print the generated JS (debugging aid). */
  show?: boolean;
}

export function compileToSource(script: any, opts: RtOptions = {}): string {
  lastSource = '';
  new JSG(script, { entry: script, procedures: opts.procedures ?? {} }, {
    getName: () => 'Sprite1',
    isStage: opts.isStage ?? false,
    effects: EFFECTS,
    runtime: { debug: false, getOpcodeFunction: () => () => {}, getTargetForStage: () => null },
    variables: {},
  }).compile();
  return lastSource;
}

// Canonical form for structural comparison. Drops:
//  - `blockType` (jsgen stamps it onto compat nodes; unwarp's IR omits it as redundant)
//  - `type` (a type-state refinement hint; the decompiler infers a precise number type while the
//    native IR often uses the broad ANY type -- semantically equivalent, so not compared)
//  - `ignoreState` / `entryState` / `exitState` bookkeeping fields (both IRs carry them, irrelevant to equality)
//  - empty `substacks: {}` / `fields: {}` (unwarp's recognizers always attach these maps; an empty map is
//    equivalent to absence)
//  - `cast.*` wrappers: jsgen inserts these at code-generation time (`input.toType(...)`) rather than
//    reading them from the IR, so a cast present in the JS says nothing about the source IR. Scratch has
//    no cast blocks either, so they vanish again on the way to project.json.
//  - constant-compat-inputs recovered as `fields`: jsgen serializes a constant compat input as a bare JS
//    literal inside the inputs object literal, indistinguishable from a real field. That is a genuine
//    jsgen limitation (the two IRs are semantically equivalent, just not byte-identical), so the fixtures
//    use expression-valued (VAR_GET) compat inputs to keep the round-trip exactly structural.
export function norm(b: any): any {
  const hasSub = (sub: any) => !!sub && Object.keys(sub).length > 0;
  const walkSubstacks = (sub: any): any => {
    const o: any = {};
    for (const n of Object.keys(sub)) o[n] = { blocks: sub[n].blocks.map(norm) };
    return o;
  };
  const walk = (v: any): any => {
    if (!v || typeof v !== 'object') return v;
    if (v.opcode !== undefined) {
      if (typeof v.opcode === 'string' && v.opcode.startsWith('cast.')) return walk(v.inputs.target);
      // jsgen emits byte-identical JS for the looks backdrop reporters and the sensing
      // "backdrop #/name of Stage" reporters; the decompiler must pick the looks form.
      const op = v.opcode === 'sensing.of.backdropNumber' ? 'looks.backdropNumber'
        : v.opcode === 'sensing.of.backdropName' ? 'looks.backdropName' : v.opcode;
      const o: any = { op, yields: v.yields };
      for (const k of Object.keys(v.inputs || {})) {
        if (k === 'blockType') continue;
        // the sensing "backdrop #/name of Stage" form carries an `object` input that the
        // decompiled looks form cannot (the JS is identical); drop it in canonical form.
        if (k === 'object' && (op === 'looks.backdropNumber' || op === 'looks.backdropName')) continue;
        if (k === 'substacks') { if (hasSub(v.inputs[k])) o.substacks = walkSubstacks(v.inputs[k]); continue; }
        o[k] = walk(v.inputs[k]);
      }
      if (v.fields && Object.keys(v.fields).length) o.fields = walk(v.fields);
      if (hasSub(v.substacks)) o.substacks = walkSubstacks(v.substacks);
      if (v.id) o.id = v.id;
      return o;
    }
    if (v.blocks) return { blocks: v.blocks.map(norm) };
    // Plain dict (e.g. a compat block's inner `inputs`/`fields`, or a variable descriptor): recurse into values.
    const o: any = {};
    for (const k of Object.keys(v)) {
      if (k === 'substacks') { if (hasSub(v[k])) o.substacks = walkSubstacks(v[k]); continue; }
      o[k] = walk(v[k]);
    }
    return o;
  };
  return walk(b);
}

/**
 * Collect ids that name a list (vs a scalar variable) from a native block list, so the
 * decompiler's monitor-toggle recognizer can tell LIST_SHOW/HIDE from VAR_SHOW/HIDE -- jsgen
 * emits byte-identical JS for both. We read them off the `list`/`lists` inputs of the native IR.
 */
function collectListIds(blocks: any[]): Set<string> {
  const ids = new Set<string>();
  const visitVal = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    if (v.blocks) { v.blocks.forEach(visitBlock); return; }
    if (v.opcode !== undefined && v.inputs) {
      for (const k of Object.keys(v.inputs)) {
        const val = v.inputs[k];
        if (k === 'list') { if (val && val.id) ids.add(val.id); }
        else if (k === 'lists') { if (Array.isArray(val)) val.forEach((x: any) => x && x.id && ids.add(x.id)); }
        visitVal(val);
      }
      if (v.substacks) for (const k of Object.keys(v.substacks)) visitVal(v.substacks[k]);
    }
  };
  const visitBlock = (b: any): void => visitVal(b);
  blocks.forEach(visitBlock);
  return ids;
}

/** Compile `blocks` with the real jsgen, decompile the result and assert structural equality. */
export function roundtrip(name: string, blocks: any[], opts: RtOptions = {}) {
  test(name, () => {
    if (!JSG) { test.skip('scratch-vm compiler not available'); return; }
    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack(blocks);
    native.yields = opts.yields ?? true;
    native.warpTimer = opts.warp ?? true;
    native.isWarp = opts.warp ?? true;
    native.isProcedure = opts.isProcedure ?? false;
    native.arguments = opts.args ?? [];
    native.topBlockId = 'top1';
    if (opts.isProcedure) native.procedureCode = 'proc %s';
    const src = compileToSource(native, opts);
    if (opts.show) console.log(`\n--- ${name} ---\n${src}\n`);
    const listIds = collectListIds(blocks);
    let dec;
    try {
      dec = decompileScript(src, { variant: 'Wfoo', listIds });
    } catch (e) {
      throw new Error(`decompile threw for ${name}: ${(e as Error).message}\n--- source ---\n${src}`);
    }
    const expected = blocks.map(norm);
    // jsgen always appends `retire(); return;` -> control.stopScript; ignore that trailing block.
    const got = dec.stack!.blocks.map(norm);
    assert.deepEqual(got.slice(0, expected.length), expected,
      `round-trip mismatch for ${name}\n--- source ---\n${src}`);
  });
}

// ---- fixture builders ----------------------------------------------------

export const C = (v: any) => new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.STRING, { value: String(v) });
export const N = (v: any) => new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.NUMBER, { value: v });
export const B = (v: boolean) => new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.BOOLEAN, { value: v });
export const COLOR = (a: number, b: number, c: number) => new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.COLOR, { value: [a, b, c] });
export const VB = (id: string, scope: 'target' | 'stage' = 'target', isCloud = false) => ({ scope, id, name: id, isCloud });
export const VAR = (id: string) => new INTER.IntermediateInput(ENUMS.InputOpcode.VAR_GET, ENUMS.InputType.ANY, { variable: VB(id) });

/** Build an input node: `IN('OP_ADD', {left, right})`, type defaults to ANY. */
export const IN = (op: string, inputs: any = {}, type?: number) =>
  new INTER.IntermediateInput((ENUMS.InputOpcode as any)[op], type ?? ENUMS.InputType.ANY, inputs);
/** Build a stacked block: `SB('VAR_SET', {...})`. */
export const SB = (op: string, inputs: any = {}, yields = false) =>
  new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any)[op], inputs, yields);
/** Build a substack. */
export const STACK = (...blocks: any[]) => new INTER.IntermediateStack(blocks);
