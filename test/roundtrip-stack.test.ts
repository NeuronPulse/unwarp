/**
 * Round-trip coverage for every stacked block (StackOpcode) jsgen can emit, including the
 * shapes that depend on operand constants (`delete 1 of list` -> shift(), `delete last` -> pop(), ...).
 */
import { roundtrip, ENUMS, C, N, B, COLOR, VB, VAR, IN, SB, STACK } from './harness';

const rt = (name: string, blocks: any[], opts: any = {}) => roundtrip(`stack: ${name}`, blocks, opts);
const TY = () => ENUMS.InputType;
const SAY = (m: string) => SB('LOOKS_SAY', { message: C(m) });

// ---- control -------------------------------------------------------------

rt('if (no else)', [SB('CONTROL_IF_ELSE', {
  condition: VAR('A'), whenTrue: STACK(SAY('t')), whenFalse: STACK(),
})]);
rt('if / else', [SB('CONTROL_IF_ELSE', {
  condition: VAR('A'), whenTrue: STACK(SAY('t')), whenFalse: STACK(SAY('f')),
})]);
rt('nested ifs', [SB('CONTROL_IF_ELSE', {
  condition: VAR('A'),
  whenTrue: STACK(SB('CONTROL_IF_ELSE', { condition: VAR('B'), whenTrue: STACK(SAY('tt')), whenFalse: STACK(SAY('tf')) })),
  whenFalse: STACK(),
})]);
rt('repeat (integer count)', [SB('CONTROL_REPEAT', {
  times: IN('CONSTANT', { value: 4 }, TY().NUMBER_POS_INT), do: STACK(SAY('x')),
})]);
rt('repeat (rounded count)', [SB('CONTROL_REPEAT', { times: VAR('A'), do: STACK(SAY('x')) })]);
rt('repeat (empty body)', [SB('CONTROL_REPEAT', { times: VAR('A'), do: STACK() })]);
rt('while (warp timer)', [SB('CONTROL_WHILE', { condition: VAR('A'), do: STACK(SAY('x')), warpTimer: true })]);
rt('while (no warp timer)', [SB('CONTROL_WHILE', { condition: VAR('A'), do: STACK(SAY('x')), warpTimer: false })], { warp: false });
rt('for', [SB('CONTROL_FOR', { variable: VB('I'), count: VAR('A'), do: STACK(SAY('x')) })]);
rt('for (no warp timer)', [SB('CONTROL_FOR', { variable: VB('I'), count: VAR('A'), do: STACK(SAY('x')) })], { warp: false });
rt('repeat (no warp timer)', [SB('CONTROL_REPEAT', { times: VAR('A'), do: STACK(SAY('x')) })], { warp: false });
rt('empty script', []);
rt('wait', [SB('CONTROL_WAIT', { seconds: N(1) }, true)]);
rt('wait with procedure arg seconds', [SB('CONTROL_WAIT', { seconds: IN('PROCEDURE_ARGUMENT', { index: 0 }) }, true)], { isProcedure: true, args: ['x'], warp: false });
rt('wait until', [SB('CONTROL_WAIT_UNTIL', { condition: VAR('A') }, true)]);
rt('stop all', [SB('CONTROL_STOP_ALL', {}, true)]);
rt('stop other scripts', [SB('CONTROL_STOP_OTHERS')]);
rt('stop this script', [SB('CONTROL_STOP_SCRIPT')]);
rt('create clone', [SB('CONTROL_CLONE_CREATE', { target: C('_myself_') })]);
rt('delete this clone', [SB('CONTROL_CLONE_DELETE')]);
rt('clear counter', [SB('CONTROL_CLEAR_COUNTER')]);
rt('increment counter', [SB('CONTORL_INCR_COUNTER')]);

// ---- events --------------------------------------------------------------

rt('broadcast', [SB('EVENT_BROADCAST', { broadcast: C('go') })]);
rt('broadcast and wait', [SB('EVENT_BROADCAST_AND_WAIT', { broadcast: C('go') }, true)]);

// ---- variables -----------------------------------------------------------

rt('set var', [SB('VAR_SET', { variable: VB('V1'), value: C('hello') })]);
rt('set cloud var', [SB('VAR_SET', { variable: VB('☁ V1', 'stage', true), value: N(5) })]);
rt('show / hide var', [SB('VAR_SHOW', { variable: VB('V1') }), SB('VAR_HIDE', { variable: VB('V1') })]);

// ---- lists ---------------------------------------------------------------

rt('add to list', [SB('LIST_ADD', { list: VB('L1'), item: VAR('A') })]);
rt('delete 1 of list (shift)', [SB('LIST_DELETE', { list: VB('L1'), index: N(1) })]);
rt('delete last of list (pop)', [SB('LIST_DELETE', { list: VB('L1'), index: C('last') })]);
rt('delete i of list', [SB('LIST_DELETE', { list: VB('L1'), index: VAR('I') })]);
rt('delete all of list', [SB('LIST_DELETE_ALL', { list: VB('L1') })]);
rt('insert at 1 (unshift)', [SB('LIST_INSERT', { list: VB('L1'), index: N(1), item: VAR('A') })]);
rt('insert at i', [SB('LIST_INSERT', { list: VB('L1'), index: VAR('I'), item: VAR('A') })]);
rt('replace item', [SB('LIST_REPLACE', { list: VB('L1'), index: VAR('I'), item: VAR('A') })]);
rt('show / hide list', [SB('LIST_SHOW', { list: VB('L1') }), SB('LIST_HIDE', { list: VB('L1') })]);

// ---- looks ---------------------------------------------------------------

rt('say / think', [SB('LOOKS_SAY', { message: VAR('A') }), SB('LOOKS_THINK', { message: C('hmm') })]);
rt('set / change / clear effect', [
  SB('LOOKS_EFFECT_SET', { effect: 'ghost', value: N(50) }),
  SB('LOOKS_EFFECT_CHANGE', { effect: 'color', value: VAR('A') }),
  SB('LOOKS_EFFECT_CLEAR'),
]);
rt('set / change size', [
  SB('LOOKS_SIZE_SET', { size: N(150) }),
  SB('LOOKS_SIZE_CHANGE', { size: VAR('A') }),
]);
rt('layers', [
  SB('LOOKS_LAYER_FORWARD', { layers: N(1) }),
  SB('LOOKS_LAYER_BACKWARD', { layers: VAR('A') }),
  SB('LOOKS_LAYER_FRONT'),
  SB('LOOKS_LAYER_BACK'),
]);
rt('show / hide', [SB('LOOKS_SHOW'), SB('LOOKS_HIDE')]);
rt('costumes and backdrops', [
  SB('LOOKS_COSTUME_SET', { costume: C('c2') }),
  SB('LOOKS_COSTUME_NEXT'),
  SB('LOOKS_BACKDROP_SET', { backdrop: VAR('A') }),
  SB('LOOKS_BACKDROP_NEXT'),
]);

// ---- motion --------------------------------------------------------------

rt('move steps', [SB('MOTION_STEP', { steps: VAR('A') })]);
rt('set x / set y / go to xy', [
  SB('MOTION_X_SET', { x: N(10) }),
  SB('MOTION_Y_SET', { y: VAR('A') }),
  SB('MOTION_XY_SET', { x: N(1), y: N(2) }),
]);
rt('change x / change y', [
  SB('MOTION_X_CHANGE', { dx: N(10) }),
  SB('MOTION_Y_CHANGE', { dy: VAR('A') }),
]);
rt('direction / rotation style / bounce', [
  SB('MOTION_DIRECTION_SET', { direction: N(90) }),
  SB('MOTION_ROTATION_STYLE_SET', { style: 'left-right' }),
  SB('MOTION_IF_ON_EDGE_BOUNCE'),
]);

// ---- pen -----------------------------------------------------------------

rt('pen up / down / clear / stamp', [
  SB('PEN_DOWN'), SB('PEN_UP'), SB('PEN_CLEAR'), SB('PEN_STAMP'),
]);
rt('pen size', [SB('PEN_SIZE_SET', { size: N(4) }), SB('PEN_SIZE_CHANGE', { size: VAR('A') })]);
rt('pen colour', [
  SB('PEN_COLOR_SET', { color: COLOR(1, 2, 3) }),
  SB('PEN_COLOR_PARAM_SET', { param: C('brightness'), value: N(50) }),
  SB('PEN_COLOR_PARAM_CHANGE', { param: C('saturation'), value: VAR('A') }),
]);
rt('pen legacy hue / shade', [
  SB('PEN_COLOR_HUE_SET_LEGACY', { hue: N(10) }),
  SB('PEN_COLOR_HUE_CHANGE_LEGACY', { hue: VAR('A') }),
  SB('PEN_COLOR_SHADE_SET_LEGACY', { shade: N(10) }),
  SB('PEN_COLOR_SHADE_CHANGE_LEGACY', { shade: VAR('A') }),
]);

// ---- sensing / misc ------------------------------------------------------

rt('reset timer', [SB('SENSING_TIMER_RESET')]);
rt('debugger', [SB('DEBUGGER')]);
rt('visual report', [SB('VISUAL_REPORT', { input: VAR('A') })]);

// ---- hats ----------------------------------------------------------------

rt('edge-activated hat', [SB('HAT_EDGE', { id: 'hat1', condition: VAR('A') }, true), SAY('after')]);
rt('edge hat then while with warp timer', [
  SB('HAT_EDGE', { id: 'hat1', condition: VAR('A') }, true),
  SB('CONTROL_WHILE', { condition: VAR('B'), do: STACK(SB('VAR_SET', { variable: VB('V1'), value: N(1) })), warpTimer: true }),
]);
rt('predicate hat', [SB('HAT_PREDICATE', { condition: VAR('A') }, true), SAY('after')]);

// ---- procedures ----------------------------------------------------------

const PROCS = { procedures: { Wbar: { stack: {}, yields: false } } };
rt('call procedure (no args)', [SB('PROCEDURE_CALL', { code: 'bar', variant: 'Wbar', arguments: [] })], PROCS);
rt('call procedure (args)', [SB('PROCEDURE_CALL', { code: 'bar', variant: 'Wbar', arguments: [VAR('A'), C('x')] })], PROCS);
rt('call yielding procedure', [SB('PROCEDURE_CALL', { code: 'bar', variant: 'Wbar', arguments: [VAR('A')] }, true)], { procedures: { Wbar: { stack: {}, yields: true } } });
rt('yielding procedure call inside if', [SB('CONTROL_IF_ELSE', {
  condition: VAR('A'),
  whenTrue: STACK(SB('PROCEDURE_CALL', { code: 'bar', variant: 'Wbar', arguments: [] }, true)),
  whenFalse: STACK(),
})], { procedures: { Wbar: { stack: {}, yields: true } } });
rt('non-yielding procedure call inside repeat', [SB('CONTROL_REPEAT', {
  times: VAR('A'),
  do: STACK(SB('PROCEDURE_CALL', { code: 'bar', variant: 'Wbar', arguments: [VAR('A')] })),
})], PROCS);
rt('return from procedure', [SB('PROCEDURE_RETURN', { value: VAR('A') })], { isProcedure: true });

// ---- sequencing ----------------------------------------------------------

rt('a long straight-line script', [
  SB('MOTION_STEP', { steps: N(10) }),
  SB('LOOKS_SAY', { message: C('hi') }),
  SB('VAR_SET', { variable: VB('V1'), value: IN('OP_ADD', { left: VAR('V1'), right: N(1) }) }),
  SB('LIST_ADD', { list: VB('L1'), item: VAR('V1') }),
  SB('CONTROL_IF_ELSE', {
    condition: IN('OP_GREATER', { left: VAR('V1'), right: N(10) }),
    whenTrue: STACK(SB('CONTROL_STOP_SCRIPT')),
    whenFalse: STACK(),
  }),
]);
rt('loops nested three deep', [SB('CONTROL_REPEAT', {
  times: VAR('A'),
  do: STACK(SB('CONTROL_WHILE', {
    condition: VAR('B'),
    warpTimer: true,
    do: STACK(SB('CONTROL_FOR', { variable: VB('I'), count: N(3), do: STACK(SAY('deep')) })),
  })),
})]);

// ---- tricky / edge cases -------------------------------------------------

// stop all mid-sequence: jsgen emits `retire(); return;` so the trailing block is dead
// code, but it is still present in the source and must decompile back to its own block.
rt('stop all then dead code', [
  SB('CONTROL_STOP_ALL', {}, true),
  SAY('after'),
]);

// stop this script mid-sequence behaves the same way.
rt('stop script then dead code', [
  SB('CONTROL_STOP_SCRIPT'),
  SAY('after'),
]);

// A list used both as a real list operation and via its monitor toggle must stay a LIST_*.
rt('list op + show/hide of same list', [
  SB('LIST_ADD', { list: VB('L1'), item: VAR('A') }),
  SB('LIST_SHOW', { list: VB('L1') }),
  SB('LIST_HIDE', { list: VB('L1') }),
]);

// Mixed variable and list monitors must decompile to the correct opcodes.
rt('mixed var + list monitors', [
  SB('VAR_SHOW', { variable: VB('V1') }),
  SB('LIST_SHOW', { list: VB('L1') }),
  SB('VAR_HIDE', { variable: VB('V1') }),
  SB('LIST_HIDE', { list: VB('L1') }),
]);

// Hat followed by a hat (two edge activations) -- the recognizer must not swallow the second.
rt('two edge-activated hats', [
  SB('HAT_EDGE', { id: 'hatA', condition: VAR('A') }, true),
  SB('HAT_EDGE', { id: 'hatB', condition: VAR('B') }, true),
]);

// A hat whose condition is a nested boolean expression.
rt('edge hat with compound condition', [
  SB('HAT_EDGE', { id: 'hat1', condition: IN('OP_AND', { left: VAR('A'), right: VAR('B') }) }, true),
  SAY('after'),
]);

// predicate hat whose condition is a comparison.
rt('predicate hat with comparison', [
  SB('HAT_PREDICATE', { condition: IN('OP_LESS', { left: VAR('A'), right: N(10) }) }, true),
  SAY('after'),
]);

