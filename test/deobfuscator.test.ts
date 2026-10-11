/**
 * Obfuscation round-trip: wrap a jsgen-compiled factory the same way 02packager does, run
 * javascript-obfuscator at three strength levels, then confirm that deobfuscate + decompile
 * reconstructs the original IR. Skips if scratch-vm's jsgen is unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompileScript } from '../src/decompiler/index';
import { deobfuscateFactorySource } from '../src/deobfuscator/index';
import { JSG, INTER, ENUMS, compileToSource, STACK, SB, C, N, B, VB, VAR, IN } from './harness';

let JSO: any = null;
try { JSO = require('javascript-obfuscator'); } catch { JSO = null; }

/** Mirror 02packager's `wrapCompiledFactorySourceForObfuscation` + eval-string store. */
function packagerWrap(source: string): string {
  const anonymized = source.replace(/^\s*(async\s+)?function\s+[^(]+\s*\(/, (_m: string, a: string = '') => `${a}function(`);
  return `(()=>{const __o2_factory_out__=${anonymized};return __o2_factory_out__;})()`;
}

/** Store the obfuscated factory as `eval("<code>")`, as 02packager serializes it. */
function storeAsEval(obfuscated: string): string {
  return `eval(${JSON.stringify(obfuscated)})`;
}

const LEVELS: Record<string, Record<string, any>> = {
  light: {
    compact: true, controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
    disableConsoleOutput: false, identifierNamesGenerator: 'hexadecimal', numbersToExpressions: false,
    renameGlobals: false, selfDefending: false, simplify: true, splitStrings: false, stringArray: true,
    stringArrayCallsTransform: false, stringArrayEncoding: [], stringArrayIndexesType: ['hexadecimal-number'],
    stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 1, stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75, target: 'browser', transformObjectKeys: false, unicodeEscapeSequence: false,
  },
  balanced: {
    compact: true, controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
    disableConsoleOutput: false, identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true,
    renameGlobals: false, selfDefending: false, simplify: true, splitStrings: true, splitStringsChunkLength: 8,
    stringArray: true, stringArrayCallsTransform: false, stringArrayEncoding: ['base64'],
    stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true, stringArrayShuffle: true,
    stringArrayWrappersCount: 1, stringArrayWrappersType: 'function', stringArrayThreshold: 1,
    target: 'browser', transformObjectKeys: false, unicodeEscapeSequence: false,
  },
  strong: {
    compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.3, deadCodeInjection: false,
    debugProtection: false, disableConsoleOutput: false, identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true, renameGlobals: false, selfDefending: true, simplify: true,
    splitStrings: true, splitStringsChunkLength: 6, stringArray: true, stringArrayCallsTransform: false,
    stringArrayEncoding: ['rc4'], stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true,
    stringArrayShuffle: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function',
    stringArrayThreshold: 1, target: 'browser', transformObjectKeys: false, unicodeEscapeSequence: false,
  },
};

const source = (() => {
  const native = new INTER.IntermediateScript();
  native.stack = new INTER.IntermediateStack([
    SB('LOOKS_SAY', { message: C('hi there') }),
    SB('VAR_SET', { variable: VB('V1'), value: N(42) }),
    SB('CONTROL_IF_ELSE', {
      condition: B(true),
      whenTrue: STACK(SB('MOTION_STEP', { steps: N(10) })),
      whenFalse: STACK(SB('LOOKS_SAY', { message: C('bye') })),
    }),
  ]);
  native.yields = true;
  native.topBlockId = 'top1';
  return compileToSource(native);
})();

const sourceRich = (() => {
  const v1 = VB('V1');
  const L1 = VB('L1');
  const native = new INTER.IntermediateScript();
  native.stack = new INTER.IntermediateStack([
    SB('EVENT_BROADCAST', { broadcast: C('go') }),
    SB('LOOKS_SAY', { message: IN('OP_JOIN', { left: C('score:'), right: VAR('V1') }) }),
    SB('LIST_ADD', { list: L1, item: N(7) }),
    SB('VAR_SET', { variable: v1, value: IN('OP_ADD', { left: VAR('V1'), right: N(1) }) }),
    SB('CONTROL_IF_ELSE', {
      condition: IN('OP_LESS', { left: VAR('V1'), right: N(10) }),
      whenTrue: STACK(SB('MOTION_STEP', { steps: N(5) })),
      whenFalse: STACK(SB('LOOKS_THINK', { message: C('done') })),
    }),
    SB('CONTROL_REPEAT', { times: N(3), do: STACK(SB('MOTION_XY_SET', { x: VAR('V1'), y: N(0) })) }),
    SB('CONTROL_WHILE', { condition: B(true), do: STACK(SB('VAR_SET', { variable: v1, value: N(0) })) }),
    SB('CONTROL_FOR', { variable: v1, count: N(5), do: STACK(SB('LIST_ADD', { list: L1, item: N(1) })) }),
    SB('EVENT_BROADCAST_AND_WAIT', { broadcast: C('go') }, true),
    SB('CONTROL_WAIT', { seconds: N(0.1) }, true),
  ]);
  native.yields = true;
  native.topBlockId = 'top1';
  return compileToSource(native);
})();

const RICH_EXPECTED = [
  'event.broadcast', 'looks.say', 'list.add', 'var.set', 'control.if',
  'control.repeat', 'control.while', 'control.for', 'event.broadcastAndWait',
  'control.wait', 'control.stopScript',
];

const CASES: [string, string, string[]][] = [
  ['simple', source, ['looks.say', 'var.set', 'control.if', 'control.stopScript']],
  ['rich', sourceRich, RICH_EXPECTED],
];

for (const [name, opts] of Object.entries(LEVELS)) {
  test(`deobfuscate + decompile survives javascript-obfuscator (${name})`, () => {
    if (!JSG || !JSO) { test.skip('jsgen or javascript-obfuscator unavailable'); return; }
    for (const [caseName, src, expected] of CASES) {
      const wrapped = packagerWrap(src);
      const obfuscated = JSO.obfuscate(wrapped, opts).getObfuscatedCode();
      const res = deobfuscateFactorySource(storeAsEval(obfuscated));
      assert.ok(res.decoded, `string-array should have been decoded (${caseName})`);
      assert.ok(res.factoryFound, `factory IIFE should have been located (${caseName})`);
      const script = decompileScript(res.source);
      const got = script.stack!.blocks.map((b: any) => b.opcode);
      assert.deepEqual(got, expected,
        `mismatch at level ${name} (${caseName})\n--- deobfuscated ---\n${res.source}`);
    }
  });
}

/**
 * Stress test: run the rich 11-opcode script through strong-level obfuscation
 * many times (each run produces different random output) and confirm every
 * iteration deobfuscates + decompiles to the expected opcode sequence.
 */
test('deobfuscate + decompile stress: strong level ×30', () => {
  if (!JSG || !JSO) { test.skip('jsgen or javascript-obfuscator unavailable'); return; }
  const ITERS = 30;
  for (let i = 0; i < ITERS; i++) {
    const wrapped = packagerWrap(sourceRich);
    const obfuscated = JSO.obfuscate(wrapped, LEVELS.strong).getObfuscatedCode();
    const res = deobfuscateFactorySource(storeAsEval(obfuscated));
    assert.ok(res.decoded, `iter ${i}: string-array should have been decoded`);
    assert.ok(res.factoryFound, `iter ${i}: factory IIFE should have been located`);
    const script = decompileScript(res.source);
    const got = script.stack!.blocks.map((b: any) => b.opcode);
    assert.deepEqual(got, RICH_EXPECTED,
      `iter ${i} mismatch\n--- deobfuscated ---\n${res.source}`);
  }
});
