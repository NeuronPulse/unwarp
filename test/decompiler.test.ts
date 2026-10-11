import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompileScript, InputOpcode, StackOpcode } from '../src/decompiler/index';
import { factory } from './fixtures';

function firstBlock(script: any) {
    return script.stack.blocks[0];
}

test('addition of two constants stays an operator block (structural fidelity)', () => {
    const script = decompileScript(factory('b0.value = (1 + 2);'));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.VAR_SET);
    assert.equal(block.inputs.variable.id, 'V1');
    const value = block.inputs.value;
    assert.equal(value.opcode, InputOpcode.OP_ADD);
    assert.equal(value.inputs.left.opcode, InputOpcode.CONSTANT);
    assert.equal(value.inputs.left.inputs.value, 1);
    assert.equal(value.inputs.right.opcode, InputOpcode.CONSTANT);
    assert.equal(value.inputs.right.inputs.value, 2);
});

test('change variable by: v = v + 5 -> OP_ADD(VAR_GET, 5)', () => {
    const script = decompileScript(factory('b0.value = (b0.value + 5);'));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.VAR_SET);
    const value = block.inputs.value;
    assert.equal(value.opcode, InputOpcode.OP_ADD);
    assert.equal(value.inputs.left.opcode, InputOpcode.VAR_GET);
    assert.equal(value.inputs.left.inputs.variable.id, 'V1');
    assert.equal(value.inputs.right.opcode, InputOpcode.CONSTANT);
    assert.equal(value.inputs.right.inputs.value, 5);
});

test('if / else with equality', () => {
    const script = decompileScript(factory(
        'if ((b0.value === 2)) {\n  b0.value = 5;\n} else {\n  b0.value = 6;\n}',
    ));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.CONTROL_IF_ELSE);
    assert.equal(block.inputs.condition.opcode, InputOpcode.OP_EQUALS);
    assert.equal(block.inputs.condition.inputs.left.opcode, InputOpcode.VAR_GET);
    assert.equal(block.inputs.condition.inputs.right.inputs.value, 2);
    assert.equal(block.inputs.whenTrue.blocks.length, 1);
    assert.equal(block.inputs.whenFalse.blocks.length, 1);
});

test('constant comparison stays an operator block', () => {
    const script = decompileScript(factory('if ((1 === 2)) {\n  b0.value = 1;\n}'));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.CONTROL_IF_ELSE);
    assert.equal(block.inputs.condition.opcode, InputOpcode.OP_EQUALS);
    assert.equal(block.inputs.condition.inputs.left.opcode, InputOpcode.CONSTANT);
    assert.equal(block.inputs.condition.inputs.left.inputs.value, 1);
    assert.equal(block.inputs.condition.inputs.right.opcode, InputOpcode.CONSTANT);
    assert.equal(block.inputs.condition.inputs.right.inputs.value, 2);
});

test('repeat (for-loop) with change-variable body', () => {
    const script = decompileScript(factory(
        'for (var a0 = 10; a0 > 0; a0--) {\n  b0.value = (b0.value + 1);\n}',
    ));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.CONTROL_REPEAT);
    assert.equal(block.inputs.times.inputs.value, 10);
    assert.equal(block.inputs.do.blocks.length, 1);
    assert.equal(block.inputs.do.blocks[0].opcode, StackOpcode.VAR_SET);
});

test('forever -> while(true)', () => {
    const script = decompileScript(factory('while (true) {\n  b0.value = 1;\n}'));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.CONTROL_WHILE);
    assert.equal(block.inputs.condition.opcode, InputOpcode.CONSTANT);
    assert.equal(block.inputs.condition.inputs.value, true);
    assert.equal(script.yields, true);
});

test('logical and / comparison nesting', () => {
    const script = decompileScript(factory('b0.value = ((b0.value === 2) && (b0.value > 1));'));
    const block = firstBlock(script);
    const value = block.inputs.value;
    assert.equal(value.opcode, InputOpcode.OP_AND);
    assert.equal(value.inputs.left.opcode, InputOpcode.OP_EQUALS);
    assert.equal(value.inputs.right.opcode, InputOpcode.OP_GREATER);
    assert.equal(value.inputs.right.inputs.right.inputs.value, 1);
});

test('procedure call recovers variant and arguments', () => {
    const script = decompileScript(factory('thread.procedures["Wabc"](1, 2);'));
    const block = firstBlock(script);
    assert.equal(block.opcode, StackOpcode.PROCEDURE_CALL);
    assert.equal(block.inputs.variant, 'Wabc');
    assert.equal(block.inputs.code, 'abc');
    assert.equal(block.inputs.arguments.length, 2);
    assert.equal(block.inputs.arguments[0].inputs.value, 1);
    assert.equal(block.inputs.arguments[1].inputs.value, 2);
});

test('trig degree form -> OP_SIN', () => {
    // Math.round(Math.sin((Math.PI * x) / 180) * 1e10) / 1e10  with x = 90 -> sin(90deg)=1
    const script = decompileScript(factory(
        'b0.value = (Math.round(Math.sin((Math.PI * 90) / 180) * 1e10) / 1e10);',
    ));
    const block = firstBlock(script);
    assert.equal(block.inputs.value.opcode, InputOpcode.OP_SIN);
    // constant x folds to 90; verify the operand is a constant 90
    assert.equal(block.inputs.value.inputs.value.opcode, InputOpcode.CONSTANT);
    assert.equal(block.inputs.value.inputs.value.inputs.value, 90);
});
