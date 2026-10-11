/**
 * Recognizer coverage for command blocks. Every fixture body is a verbatim copy of what
 * scratch-vm/src/compiler/jsgen.js emits for the corresponding StackOpcode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompileScript, InputOpcode, StackOpcode } from '../src/decompiler/index';
import { factory } from './fixtures';

function blocks(body: string, opts?: { gen?: boolean; params?: string[]; setup?: string }) {
    return decompileScript(factory(body, opts)).stack!.blocks;
}

function only(body: string, opts?: { gen?: boolean; params?: string[]; setup?: string }) {
    const bs = blocks(body, opts);
    assert.equal(bs.length, 1, `expected exactly one block, got ${bs.map((b: any) => b.opcode).join(', ')}`);
    return bs[0];
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('list add: push + monitor bookkeeping -> LIST_ADD', () => {
    const b = only('b0.value.push("x");\nb0._monitorUpToDate = false;');
    assert.equal(b.opcode, StackOpcode.LIST_ADD);
    assert.equal(b.inputs.list.id, 'V1');
    assert.equal(b.inputs.item.inputs.value, 'x');
});

test('list delete last: pop() -> LIST_DELETE with index "last"', () => {
    const b = only('b0.value.pop();\nb0._monitorUpToDate = false;');
    assert.equal(b.opcode, StackOpcode.LIST_DELETE);
    assert.equal(b.inputs.index.inputs.value, 'last');
});

test('list delete first: shift() -> LIST_DELETE with index 1', () => {
    const b = only('b0.value.shift();\nb0._monitorUpToDate = false;');
    assert.equal(b.opcode, StackOpcode.LIST_DELETE);
    assert.equal(b.inputs.index.inputs.value, 1);
});

test('list delete nth: listDelete(list, n) -> LIST_DELETE', () => {
    const b = only('listDelete(b0, 3);');
    assert.equal(b.opcode, StackOpcode.LIST_DELETE);
    assert.equal(b.inputs.index.inputs.value, 3);
});

test('list delete all: .value = [] -> LIST_DELETE_ALL', () => {
    const b = only('b0.value = [];');
    assert.equal(b.opcode, StackOpcode.LIST_DELETE_ALL);
    assert.equal(b.inputs.list.id, 'V1');
});

test('list insert at 1: unshift() -> LIST_INSERT with index 1', () => {
    const b = only('b0.value.unshift("x");\nb0._monitorUpToDate = false;');
    assert.equal(b.opcode, StackOpcode.LIST_INSERT);
    assert.equal(b.inputs.index.inputs.value, 1);
    assert.equal(b.inputs.item.inputs.value, 'x');
});

test('list insert at n: listInsert -> LIST_INSERT', () => {
    const b = only('listInsert(b0, 2, "x");');
    assert.equal(b.opcode, StackOpcode.LIST_INSERT);
    assert.equal(b.inputs.index.inputs.value, 2);
});

test('list replace: listReplace -> LIST_REPLACE', () => {
    const b = only('listReplace(b0, 2, "x");');
    assert.equal(b.opcode, StackOpcode.LIST_REPLACE);
    assert.equal(b.inputs.index.inputs.value, 2);
    assert.equal(b.inputs.item.inputs.value, 'x');
});

test('monitor checkbox toggle -> VAR_SHOW / VAR_HIDE', () => {
    const show = only('runtime.monitorBlocks.changeBlock({ id: "V1", element: "checkbox", value: true }, runtime);');
    assert.equal(show.opcode, StackOpcode.VAR_SHOW);
    assert.equal(show.inputs.variable.id, 'V1');
    const hide = only('runtime.monitorBlocks.changeBlock({ id: "V1", element: "checkbox", value: false }, runtime);');
    assert.equal(hide.opcode, StackOpcode.VAR_HIDE);
});

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

test('set effect -> LOOKS_EFFECT_SET', () => {
    const b = only('target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", 50));');
    assert.equal(b.opcode, StackOpcode.LOOKS_EFFECT_SET);
    assert.equal(b.inputs.effect, 'ghost');
    assert.equal(b.inputs.value.inputs.value, 50);
});

test('change effect folds the current value in -> LOOKS_EFFECT_CHANGE', () => {
    const b = only(
        'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", ' +
        'b0.value + target.effects["ghost"]));',
    );
    assert.equal(b.opcode, StackOpcode.LOOKS_EFFECT_CHANGE);
    assert.equal(b.inputs.effect, 'ghost');
    assert.equal(b.inputs.value.opcode, InputOpcode.VAR_GET);
});

test('clear effects / layer ops', () => {
    assert.equal(only('target.clearEffects();').opcode, StackOpcode.LOOKS_EFFECT_CLEAR);
    assert.equal(only('target.goToFront();').opcode, StackOpcode.LOOKS_LAYER_FRONT);
    assert.equal(only('target.goToBack();').opcode, StackOpcode.LOOKS_LAYER_BACK);
    const fwd = only('target.goForwardLayers(3);');
    assert.equal(fwd.opcode, StackOpcode.LOOKS_LAYER_FORWARD);
    assert.equal(fwd.inputs.layers.inputs.value, 3);
    assert.equal(only('target.goBackwardLayers(3);').opcode, StackOpcode.LOOKS_LAYER_BACKWARD);
});

test('setSize distinguishes change-by from set-to', () => {
    const change = only('target.setSize((target.size + 10));');
    assert.equal(change.opcode, StackOpcode.LOOKS_SIZE_CHANGE);
    assert.equal(change.inputs.size.inputs.value, 10);
    const set = only('target.setSize(150);');
    assert.equal(set.opcode, StackOpcode.LOOKS_SIZE_SET);
    assert.equal(set.inputs.size.inputs.value, 150);
});

test('show / hide drop the trailing _renderBubble call', () => {
    assert.equal(
        only('target.setVisible(false);\nruntime.ext_scratch3_looks._renderBubble(target);').opcode,
        StackOpcode.LOOKS_HIDE,
    );
    assert.equal(
        only('target.setVisible(true);\nruntime.ext_scratch3_looks._renderBubble(target);').opcode,
        StackOpcode.LOOKS_SHOW,
    );
});

test('costume / backdrop switch vs next', () => {
    assert.equal(only('target.setCostume((target.currentCostume + 1));').opcode, StackOpcode.LOOKS_COSTUME_NEXT);
    const setCostume = only('runtime.ext_scratch3_looks._setCostume(target, "cat");');
    assert.equal(setCostume.opcode, StackOpcode.LOOKS_COSTUME_SET);
    assert.equal(setCostume.inputs.costume.inputs.value, 'cat');
    assert.equal(
        only('runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true);').opcode,
        StackOpcode.LOOKS_BACKDROP_NEXT,
    );
    const setBackdrop = only('runtime.ext_scratch3_looks._setBackdrop(stage, "sky");');
    assert.equal(setBackdrop.opcode, StackOpcode.LOOKS_BACKDROP_SET);
    assert.equal(setBackdrop.inputs.backdrop.inputs.value, 'sky');
});

test('say / think', () => {
    const say = only('runtime.ext_scratch3_looks._say("hi", target);');
    assert.equal(say.opcode, StackOpcode.LOOKS_SAY);
    assert.equal(say.inputs.message.inputs.value, 'hi');
    assert.equal(only('runtime.ext_scratch3_looks._think("hm", target);').opcode, StackOpcode.LOOKS_THINK);
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

test('setXY resolves to five different motion blocks', () => {
    const dx = only('target.setXY((target.x + 10), target.y);');
    assert.equal(dx.opcode, StackOpcode.MOTION_X_CHANGE);
    assert.equal(dx.inputs.dx.inputs.value, 10);

    const dy = only('target.setXY(target.x, (target.y + 10));');
    assert.equal(dy.opcode, StackOpcode.MOTION_Y_CHANGE);
    assert.equal(dy.inputs.dy.inputs.value, 10);

    const setX = only('target.setXY(50, target.y);');
    assert.equal(setX.opcode, StackOpcode.MOTION_X_SET);
    assert.equal(setX.inputs.x.inputs.value, 50);

    const setY = only('target.setXY(target.x, 50);');
    assert.equal(setY.opcode, StackOpcode.MOTION_Y_SET);
    assert.equal(setY.inputs.y.inputs.value, 50);

    const setXY = only('target.setXY(1, 2);');
    assert.equal(setXY.opcode, StackOpcode.MOTION_XY_SET);
    assert.equal(setXY.inputs.x.inputs.value, 1);
    assert.equal(setXY.inputs.y.inputs.value, 2);
});

test('setXY drops the interpolation reset that trails a modulo input', () => {
    const b = only('target.setXY(1, 2);\nif (target.interpolationData) target.interpolationData = null;');
    assert.equal(b.opcode, StackOpcode.MOTION_XY_SET);
});

test('move steps / bounce / direction / rotation style', () => {
    const step = only('runtime.ext_scratch3_motion._moveSteps(10, target);');
    assert.equal(step.opcode, StackOpcode.MOTION_STEP);
    assert.equal(step.inputs.steps.inputs.value, 10);
    assert.equal(
        only('runtime.ext_scratch3_motion._ifOnEdgeBounce(target);').opcode,
        StackOpcode.MOTION_IF_ON_EDGE_BOUNCE,
    );
    const dir = only('target.setDirection(90);');
    assert.equal(dir.opcode, StackOpcode.MOTION_DIRECTION_SET);
    assert.equal(dir.inputs.direction.inputs.value, 90);
    const style = only('target.setRotationStyle("left-right");');
    assert.equal(style.opcode, StackOpcode.MOTION_ROTATION_STYLE_SET);
    assert.equal(style.inputs.style, 'left-right');
});

// ---------------------------------------------------------------------------
// Pen
// ---------------------------------------------------------------------------

test('pen up / down / clear / stamp', () => {
    assert.equal(only('runtime.ext_pen.clear();').opcode, StackOpcode.PEN_CLEAR);
    assert.equal(only('runtime.ext_pen._penDown(target);').opcode, StackOpcode.PEN_DOWN);
    assert.equal(only('runtime.ext_pen._penUp(target);').opcode, StackOpcode.PEN_UP);
    assert.equal(only('runtime.ext_pen._stamp(target);').opcode, StackOpcode.PEN_STAMP);
});

test('pen size / colour / legacy hue+shade', () => {
    const size = only('runtime.ext_pen._setPenSizeTo(5, target);');
    assert.equal(size.opcode, StackOpcode.PEN_SIZE_SET);
    assert.equal(size.inputs.size.inputs.value, 5);
    assert.equal(only('runtime.ext_pen._changePenSizeBy(2, target);').opcode, StackOpcode.PEN_SIZE_CHANGE);
    assert.equal(only('runtime.ext_pen._setPenColorToColor("#ff0000", target);').opcode, StackOpcode.PEN_COLOR_SET);
    assert.equal(
        only('runtime.ext_pen._changePenHueBy(10, target);').opcode,
        StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY,
    );
    assert.equal(
        only('runtime.ext_pen._setPenShadeToNumber(10, target);').opcode,
        StackOpcode.PEN_COLOR_SHADE_SET_LEGACY,
    );
});

test('pen colour param: 4th argument selects set vs change', () => {
    const set = only(
        'runtime.ext_pen._setOrChangeColorParam("color", 50, runtime.ext_pen._getPenState(target), false);',
    );
    assert.equal(set.opcode, StackOpcode.PEN_COLOR_PARAM_SET);
    assert.equal(set.inputs.param.inputs.value, 'color');
    assert.equal(set.inputs.value.inputs.value, 50);
    const change = only(
        'runtime.ext_pen._setOrChangeColorParam("color", 50, runtime.ext_pen._getPenState(target), true);',
    );
    assert.equal(change.opcode, StackOpcode.PEN_COLOR_PARAM_CHANGE);
});

// ---------------------------------------------------------------------------
// Control / stop
// ---------------------------------------------------------------------------

test('stop all swallows the retire it always emits', () => {
    const b = only('runtime.stopAll();\nretire(); return;');
    assert.equal(b.opcode, StackOpcode.CONTROL_STOP_ALL);
    assert.equal(b.yields, true);
});

test('stop other scripts / stop this script', () => {
    assert.equal(only('runtime.stopForTarget(target, thread);').opcode, StackOpcode.CONTROL_STOP_OTHERS);
    assert.equal(only('retire(); return;').opcode, StackOpcode.CONTROL_STOP_SCRIPT);
    // inside a procedure jsgen writes `return "";` instead
    assert.equal(only('return "";').opcode, StackOpcode.CONTROL_STOP_SCRIPT);
});

test('clone create / delete', () => {
    const create = only('runtime.ext_scratch3_control._createClone("_myself_", target);');
    assert.equal(create.opcode, StackOpcode.CONTROL_CLONE_CREATE);
    assert.equal(create.inputs.target.inputs.value, '_myself_');
    const del = only(
        'if (!target.isOriginal) {\n  runtime.disposeTarget(target);\n' +
        '  runtime.stopForTarget(target);\nretire(); return;\n}',
    );
    assert.equal(del.opcode, StackOpcode.CONTROL_CLONE_DELETE);
});

test('wait: timer preamble + burn-down loop collapses to CONTROL_WAIT', () => {
    const b = only(
        'thread.timer = timer();\n' +
        'var a0 = Math.max(0, 1000 * b0.value);\n' +
        'runtime.requestRedraw();\n' +
        'yield;\n' +
        'while (thread.timer.timeElapsed() < a0) {\nyield;\n}\n' +
        'thread.timer = null;\n',
    );
    assert.equal(b.opcode, StackOpcode.CONTROL_WAIT);
    assert.equal(b.yields, true);
    assert.equal(b.inputs.seconds.opcode, InputOpcode.VAR_GET);
});

test('wait until: while (!cond) with an empty body', () => {
    const b = only('while (!(b0.value === 1)) {\nyield;\n}');
    assert.equal(b.opcode, StackOpcode.CONTROL_WAIT_UNTIL);
    assert.equal(b.inputs.condition.opcode, InputOpcode.OP_EQUALS);
    assert.equal(b.yields, true);
});

test('for-each: counter preamble + while loop -> CONTROL_FOR', () => {
    const b = only(
        'var a0 = 0; while (a0 < 10) { a0++; b0.value = a0;\n' +
        'runtime.ext_pen._penDown(target);\nyield;\n}',
    );
    assert.equal(b.opcode, StackOpcode.CONTROL_FOR);
    assert.equal(b.inputs.variable.id, 'V1');
    assert.equal(b.inputs.count.inputs.value, 10);
    assert.equal(b.inputs.do.blocks.length, 1);
    assert.equal(b.inputs.do.blocks[0].opcode, StackOpcode.PEN_DOWN);
});

test('counter clear / increment', () => {
    assert.equal(only('runtime.ext_scratch3_control._counter = 0;').opcode, StackOpcode.CONTROL_CLEAR_COUNTER);
    assert.equal(only('runtime.ext_scratch3_control._counter++;').opcode, StackOpcode.CONTORL_INCR_COUNTER);
});

test('reset timer', () => {
    assert.equal(only('runtime.ioDevices.clock.resetProjectTimer();').opcode, StackOpcode.SENSING_TIMER_RESET);
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

test('broadcast', () => {
    const b = only('startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: "go" });');
    assert.equal(b.opcode, StackOpcode.EVENT_BROADCAST);
    assert.equal(b.inputs.broadcast.inputs.value, 'go');
});

test('broadcast and wait', () => {
    const b = only('yield* waitThreads(startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: "go" }));');
    assert.equal(b.opcode, StackOpcode.EVENT_BROADCAST_AND_WAIT);
    assert.equal(b.inputs.broadcast.inputs.value, 'go');
    assert.equal(b.yields, true);
});

// ---------------------------------------------------------------------------
// Hats, procedures, monitors
// ---------------------------------------------------------------------------

test('edge-activated hat recovers its condition and block id', () => {
    const script = decompileScript(factory(
        '{\nconst resolvedValue = (b0.value === 1);\n' +
        'const id = "hat1";\n' +
        'const hasOldEdgeValue = target.hasEdgeActivatedValue(id);\n' +
        'const oldEdgeValue = target.updateEdgeActivatedValue(id, resolvedValue);\n' +
        'const edgeWasActivated = hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue;\n' +
        'if (!edgeWasActivated) {\nretire(); return;\n}\nyield;\n}\n' +
        'runtime.ext_pen._penDown(target);',
    ));
    const bs = script.stack!.blocks;
    assert.equal(bs[0].opcode, StackOpcode.HAT_EDGE);
    assert.equal(bs[0].inputs.id, 'hat1');
    assert.equal(bs[0].inputs.condition.opcode, InputOpcode.OP_EQUALS);
    assert.equal(bs[1].opcode, StackOpcode.PEN_DOWN);
    assert.equal(script.executableHat, true);
});

test('predicate hat at the top of a script -> HAT_PREDICATE', () => {
    const script = decompileScript(factory(
        'if (!(b0.value === 1)) {\nretire(); return;\n}\nyield;\n' +
        'runtime.ext_pen._penDown(target);',
    ));
    const bs = script.stack!.blocks;
    assert.equal(bs[0].opcode, StackOpcode.HAT_PREDICATE);
    assert.equal(bs[0].inputs.condition.opcode, InputOpcode.OP_EQUALS);
    assert.equal(bs[1].opcode, StackOpcode.PEN_DOWN);
    assert.equal(script.executableHat, true);
});

test('the same shape mid-script is an if containing stop-this-script, not a hat', () => {
    const bs = blocks(
        'runtime.ext_pen._penDown(target);\n' +
        'if (!(b0.value === 1)) {\nretire(); return;\n}',
    );
    assert.equal(bs[0].opcode, StackOpcode.PEN_DOWN);
    assert.equal(bs[1].opcode, StackOpcode.CONTROL_IF_ELSE);
    assert.equal(bs[1].inputs.whenTrue.blocks[0].opcode, StackOpcode.CONTROL_STOP_SCRIPT);
});

test('procedure return value', () => {
    const b = only('return (b0.value);');
    assert.equal(b.opcode, StackOpcode.PROCEDURE_RETURN);
    assert.equal(b.inputs.value.opcode, InputOpcode.VAR_GET);
});

test('cloud variable set is recovered from the follow-up cloud update', () => {
    const b = only(
        'b0.value = 1;\nruntime.ioDevices.cloud.requestUpdateVariable("score", b0.value);',
    );
    assert.equal(b.opcode, StackOpcode.VAR_SET);
    assert.equal(b.inputs.variable.isCloud, true);
    assert.equal(b.inputs.variable.name, 'score');
});

test('visual report recovers the top block id', () => {
    const script = decompileScript(factory(
        'const a0 = b0.value;if (a0 !== undefined) runtime.visualReport(target, "top1", a0);',
    ));
    const b = script.stack!.blocks[0];
    assert.equal(b.opcode, StackOpcode.VISUAL_REPORT);
    assert.equal(b.inputs.input.opcode, InputOpcode.VAR_GET);
    assert.equal(script.topBlockId, 'top1');
});

test('a warp-timer loop tail is detected and does not become an if block', () => {
    const script = decompileScript(factory(
        'while (true) {\nruntime.ext_pen._penDown(target);\nif (isStuck()) yield;\n}',
    ), { variant: 'Wfoo' });
    const b = script.stack!.blocks[0];
    assert.equal(b.opcode, StackOpcode.CONTROL_WHILE);
    assert.equal(b.inputs.do.blocks.length, 1);
    assert.equal(b.inputs.warpTimer, true);
    assert.equal(script.warpTimer, true);
    assert.equal(script.isWarp, true);
});

// ---------------------------------------------------------------------------
// Compatibility layer (blocks jsgen could not compile natively)
// ---------------------------------------------------------------------------

// The hoisted opcode function const jsgen emits for every compat block, plus a variable ref.
const COMPAT_SETUP = 'const b0 = target.variables["V1"]; const b1 = runtime.getOpcodeFunction("some_extension_do_thing");';

test('compat command block recovers opcode, inputs and fields', () => {
    const b = only(
        'yield* executeInCompatibilityLayer({ "AMOUNT": b0.value, "STYLE": "bold" }, b1, false, false, "blk42", null);',
        { setup: COMPAT_SETUP },
    );
    assert.equal(b.opcode, StackOpcode.COMPATIBILITY_LAYER);
    assert.equal(b.inputs.opcode, 'some_extension_do_thing');
    assert.equal(b.inputs.id, 'blk42');
    assert.equal(b.inputs.inputs.AMOUNT.opcode, InputOpcode.VAR_GET);
    assert.equal(b.inputs.fields.STYLE, 'bold');
    assert.equal(b.yields, true);
});

test('compat reporter block used as an input', () => {
    const b = only(
        'b0.value = (1 + (yield* executeInCompatibilityLayer({ X: b0.value }, b1, false, false, "blk9", null)));',
        { setup: COMPAT_SETUP },
    );
    assert.equal(b.opcode, StackOpcode.VAR_SET);
    const rhs = b.inputs.value;
    assert.equal(rhs.opcode, InputOpcode.OP_ADD);
    assert.equal(rhs.inputs.right.opcode, StackOpcode.COMPATIBILITY_LAYER);
    assert.equal(rhs.inputs.right.inputs.opcode, 'some_extension_do_thing');
    assert.equal(rhs.inputs.right.inputs.inputs.X.opcode, InputOpcode.VAR_GET);
});

test('compat conditional block recovers its substack (SUBSTACK)', () => {
    const b = only(
        'const b1_branch = createBranchInfo(false);\n' +
        'while (b1_branch.branch = +(yield* executeInCompatibilityLayer({ "COND": b0.value }, b1, false, false, "blkC", b1_branch))) {\n' +
        'switch (b1_branch.branch) {\n' +
        'case 1: {\nb0.value = 1;\nbreak; }\n' +
        '}\nif (!b1_branch.isLoop) break;\n}',
        { setup: COMPAT_SETUP },
    );
    assert.equal(b.opcode, StackOpcode.COMPATIBILITY_LAYER);
    assert.equal(b.inputs.opcode, 'some_extension_do_thing');
    assert.equal(b.inputs.substacks[1].blocks.length, 1);
    assert.equal(b.inputs.substacks[1].blocks[0].opcode, StackOpcode.VAR_SET);
});

test('compat loop block recovers two substacks (SUBSTACK + SUBSTACK2)', () => {
    const b = only(
        'const b1_branch = createBranchInfo(true);\n' +
        'while (b1_branch.branch = +(yield* executeInCompatibilityLayer({ }, b1, false, false, "blkL", b1_branch))) {\n' +
        'switch (b1_branch.branch) {\n' +
        'case 1: {\nb0.value = 1;\nbreak; }\n' +
        'case 2: {\nb0.value = 2;\nbreak; }\n' +
        '}\nif (!b1_branch.isLoop) break;\nif (isStuck()) yield;\n}',
        { setup: COMPAT_SETUP },
    );
    assert.equal(b.opcode, StackOpcode.COMPATIBILITY_LAYER);
    assert.equal(b.inputs.substacks[1].blocks[0].inputs.value.inputs.value, 1);
    assert.equal(b.inputs.substacks[2].blocks[0].inputs.value.inputs.value, 2);
});

test('compat block with a missing opcode const degrades to no block (never throws)', () => {
    const bs = blocks(
        'yield* executeInCompatibilityLayer({ "X": 1 }, bMissing, false, false, "blkX", null);',
        { setup: 'const b0 = target.variables["V1"];' },
    );
    assert.equal(bs.length, 0);
});
