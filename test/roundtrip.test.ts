/**
 * Round-trip: structural (native + compatibility-layer) shapes.
 * See test/harness.ts for how the real scratch-vm jsgen is driven.
 */
import { roundtrip, ENUMS, INTER, BLOCKTYPE, C, N, VB, VAR, SB, STACK, compileToSource } from './harness';
import { decompileScript, linkSources } from '../src/decompiler/index';
import { test } from 'node:test';
import assert from 'node:assert/strict';

roundtrip('native blocks (looks/motion/var/control/if-else/list)', [
  SB('LOOKS_SAY', { message: C('hi') }),
  SB('MOTION_STEP', { steps: N(10) }),
  SB('VAR_SET', { variable: VB('V1'), value: N(3) }),
  SB('CONTROL_REPEAT', { times: N(5), do: STACK(SB('MOTION_STEP', { steps: N(1) })) }),
  SB('CONTROL_IF_ELSE', {
    condition: new INTER.IntermediateInput(ENUMS.InputOpcode.CONSTANT, ENUMS.InputType.BOOLEAN, { value: true }),
    whenTrue: STACK(SB('LOOKS_SAY', { message: C('a') })),
    whenFalse: STACK(SB('LOOKS_SAY', { message: C('b') })),
  }),
  SB('LIST_ADD', { list: VB('L1'), item: C('x') }),
]);

roundtrip('compat command block', [
  SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_block', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
    inputs: { X: VAR('V1') }, fields: { STYLE: 'bold' },
  }, true),
]);

roundtrip('compat conditional block with substack', [
  SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_if', id: 'blkD', blockType: BLOCKTYPE.CONDITIONAL,
    inputs: { COND: VAR('V1') }, fields: {},
    substacks: { 1: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(9) })) },
  }, true),
]);

roundtrip('compat loop block with two substacks', [
  SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_loop', id: 'blkL', blockType: BLOCKTYPE.LOOP,
    inputs: {}, fields: {},
    substacks: {
      1: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(1) })),
      2: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(2) })),
    },
  }, true),
]);

roundtrip('compat command inside if', [SB('CONTROL_IF_ELSE', {
  condition: VAR('A'),
  whenTrue: STACK(SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_cmd', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
    inputs: { X: VAR('V1') }, fields: {},
  }, true)),
  whenFalse: STACK(),
})]);

roundtrip('if inside compat loop substack', [SB('COMPATIBILITY_LAYER', {
  opcode: 'some_ext_loop', id: 'blkL', blockType: BLOCKTYPE.LOOP,
  inputs: {}, fields: {},
  substacks: {
    1: STACK(SB('CONTROL_IF_ELSE', { condition: VAR('A'), whenTrue: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(1) })), whenFalse: STACK() })),
  },
}, true)]);

// jsgen emits `if (hasResumedFromPromise) {...}` after a compat command that is the
// LAST command of a loop body; the decompiler must treat it as noise (real bug fixed).
roundtrip('compat command last in repeat', [SB('CONTROL_REPEAT', {
  times: VAR('A'),
  do: STACK(SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_cmd', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
    inputs: { X: VAR('V1') }, fields: {},
  }, true)),
})]);
roundtrip('compat command last in while', [SB('CONTROL_WHILE', {
  condition: VAR('A'), warpTimer: false,
  do: STACK(SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_cmd', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
    inputs: { X: VAR('V1') }, fields: {},
  }, true)),
})], { warp: false });
roundtrip('compat command last in for', [SB('CONTROL_FOR', {
  variable: VB('I'), count: VAR('A'),
  do: STACK(SB('COMPATIBILITY_LAYER', {
    opcode: 'some_ext_cmd', id: 'blkC', blockType: BLOCKTYPE.COMMAND,
    inputs: { X: VAR('V1') }, fields: {},
  }, true)),
})]);

// ---- script-level flag recovery ------------------------------------------

// A compat-loop (or wait) in a warp script emits `if (isStuck()) yield;` in its body; the
// decompiler must record that as script.warpTimer, not drop it as noise (see isNoise fix).
test('warp timer recovered from compat loop', () => {
  const native = new INTER.IntermediateScript();
  native.stack = new INTER.IntermediateStack([
    new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any).COMPATIBILITY_LAYER, {
      opcode: 'some_ext_loop', id: 'blkL', blockType: BLOCKTYPE.LOOP,
      inputs: {}, fields: {},
      substacks: {
        1: new INTER.IntermediateStack([new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any).VAR_SET, { variable: VB('V1'), value: N(1) })]),
        2: new INTER.IntermediateStack([new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any).VAR_SET, { variable: VB('V1'), value: N(2) })]),
      },
    }, true),
  ]);
  native.warpTimer = true;
  native.isWarp = true;
  native.topBlockId = 'top1';
  const src = compileToSource(native);
  const dec = decompileScript(src, { variant: 'Wfoo' });
  assert.equal(dec.warpTimer, true);
});

test('warp timer recovered from control.wait', () => {
  const native = new INTER.IntermediateScript();
  native.stack = new INTER.IntermediateStack([
    new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any).CONTROL_WAIT, { seconds: N(1) }, true),
  ]);
  native.warpTimer = true;
  native.isWarp = true;
  native.topBlockId = 'top1';
  const src = compileToSource(native);
  const dec = decompileScript(src, { variant: 'Wfoo' });
  assert.equal(dec.warpTimer, true);
});

test('warp timer absent for non-warp wait', () => {
  const native = new INTER.IntermediateScript();
  native.stack = new INTER.IntermediateStack([
    new INTER.IntermediateStackBlock((ENUMS.StackOpcode as any).CONTROL_WAIT, { seconds: N(1) }, true),
  ]);
  native.warpTimer = false;
  native.isWarp = false;
  native.topBlockId = 'top1';
  const src = compileToSource(native, { warp: false, yields: true });
  const dec = decompileScript(src, { variant: 'Wfoo' });
  assert.equal(dec.warpTimer, false);
});

test('linkSources follows procedure calls transitively and stubs missing ones', () => {
  const mkScript = (block: any) => {
    const s = new INTER.IntermediateScript();
    s.stack = new INTER.IntermediateStack([block]);
    s.yields = false;
    s.warpTimer = false;
    s.isWarp = false;
    s.topBlockId = 'top1';
    return s;
  };
  const entry = mkScript(new INTER.IntermediateStackBlock(
    (ENUMS.StackOpcode as any).PROCEDURE_CALL, { code: 'bar', variant: 'Wbar', arguments: [VAR('A')] }, false,
  ));
  const bar = mkScript(new INTER.IntermediateStackBlock(
    (ENUMS.StackOpcode as any).PROCEDURE_CALL, { code: 'baz', variant: 'Wbaz', arguments: [] }, false,
  ));
  const entrySrc = compileToSource(entry, { procedures: { Wbar: { stack: {}, yields: false } } });
  const barSrc = compileToSource(bar, { procedures: { Wbaz: { stack: {}, yields: false } } });
  const { ir, missing } = linkSources(entrySrc, { Wbar: barSrc });
  assert.ok(ir.procedures.Wbar, 'Wbar should be decompiled');
  assert.ok(ir.procedures.Wbaz, 'Wbaz should be stubbed');
  assert.deepEqual(missing, ['Wbaz']);
});
