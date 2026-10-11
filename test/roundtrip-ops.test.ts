/**
 * Round-trip coverage for the operator reporters, including the shapes jsgen only emits for
 * particular operand types (`===` vs compareEqual, `!(a <= b)` vs `>` vs compareGreaterThan, ...).
 */
import { roundtrip, ENUMS, C, N, VB, VAR, IN, SB } from './harness';

const rt = (name: string, input: any, opts: any = {}) =>
  roundtrip(`op: ${name}`, [SB('VAR_SET', { variable: VB('V1'), value: input })], opts);

const TY = () => ENUMS.InputType;
/** A reporter forced to a specific type, to steer jsgen down a particular emission branch. */
const AS = (op: string, type: number, inputs: any = {}) => IN(op, inputs, type);
const NUMBER = () => AS('MOTION_X_GET', TY().NUMBER);
const NUMBER_OR_NAN = () => AS('OP_DIVIDE', TY().NUMBER_OR_NAN, { left: VAR('A'), right: VAR('B') });
const NEVER_NUMBER = (v: string) => AS('VAR_GET', TY().STRING_NAN, { variable: VB(v) });
const STR = (v: string) => IN('CAST_STRING', { target: VAR(v) }, TY().STRING);

// ---- arithmetic ----------------------------------------------------------

rt('add', IN('OP_ADD', { left: VAR('A'), right: N(1) }));
rt('subtract', IN('OP_SUBTRACT', { left: VAR('A'), right: VAR('B') }));
rt('multiply', IN('OP_MULTIPLY', { left: N(2), right: VAR('B') }));
rt('divide', IN('OP_DIVIDE', { left: VAR('A'), right: N(0) }));
rt('mod', IN('OP_MOD', { left: VAR('A'), right: N(-3) }));
rt('add of negative constant', IN('OP_ADD', { left: VAR('A'), right: N(-1.5) }));
rt('add of two constants', IN('OP_ADD', { left: N(1), right: N(2) }));
rt('subtract of two constants', IN('OP_SUBTRACT', { left: N(0), right: N(-2) }));
rt('negative constant operand', IN('OP_SUBTRACT', { left: VAR('A'), right: N(-1.5) }));

// ---- strings -------------------------------------------------------------

rt('join (literal left)', IN('OP_JOIN', { left: C('a'), right: VAR('B') }));
rt('join (both cast to string, as irgen emits)', IN('OP_JOIN', { left: STR('A'), right: STR('B') }));
rt('length', IN('OP_LENGTH', { string: STR('A') }));
rt('length over scalar variable', IN('OP_LENGTH', { string: VAR('A') }));
rt('letter of', IN('OP_LETTER_OF', { string: STR('A'), letter: N(3) }));
rt('letter of (expression index)', IN('OP_LETTER_OF', { string: STR('A'), letter: VAR('I') }));
rt('contains', IN('OP_CONTAINS', { string: STR('A'), contains: C('needle') }));

// ---- comparisons ---------------------------------------------------------

rt('equals (fallback compareEqual)', IN('OP_EQUALS', { left: VAR('A'), right: VAR('B') }));
rt('equals (numeric ===)', IN('OP_EQUALS', { left: NUMBER(), right: NUMBER() }));
rt('equals (string toLowerCase)', IN('OP_EQUALS', { left: NEVER_NUMBER('A'), right: NEVER_NUMBER('B') }));
rt('greater (fallback compareGreaterThan)', IN('OP_GREATER', { left: VAR('A'), right: VAR('B') }));
rt('greater (numeric >)', IN('OP_GREATER', { left: NUMBER(), right: NUMBER_OR_NAN() }));
rt('greater (negated <=)', IN('OP_GREATER', { left: NUMBER_OR_NAN(), right: NUMBER() }));
rt('greater (string compare)', IN('OP_GREATER', { left: NEVER_NUMBER('A'), right: NEVER_NUMBER('B') }));
rt('less (fallback compareLessThan)', IN('OP_LESS', { left: VAR('A'), right: VAR('B') }));
rt('less (numeric <)', IN('OP_LESS', { left: NUMBER_OR_NAN(), right: NUMBER() }));
rt('less (negated >=)', IN('OP_LESS', { left: NUMBER(), right: NUMBER_OR_NAN() }));
rt('less (string compare)', IN('OP_LESS', { left: NEVER_NUMBER('A'), right: NEVER_NUMBER('B') }));

// ---- boolean -------------------------------------------------------------

rt('and', IN('OP_AND', { left: VAR('A'), right: VAR('B') }));
rt('or', IN('OP_OR', { left: VAR('A'), right: VAR('B') }));
rt('not', IN('OP_NOT', { operand: VAR('A') }));
rt('not of a comparison', IN('OP_NOT', { operand: IN('OP_EQUALS', { left: VAR('A'), right: VAR('B') }) }));

// ---- math functions ------------------------------------------------------

rt('abs', IN('OP_ABS', { value: VAR('A') }));
rt('floor', IN('OP_FLOOR', { value: VAR('A') }));
rt('ceiling', IN('OP_CEILING', { value: VAR('A') }));
rt('sqrt', IN('OP_SQRT', { value: VAR('A') }));
rt('round', IN('OP_ROUND', { value: VAR('A') }));
rt('ln', IN('OP_LOG_E', { value: VAR('A') }));
rt('log', IN('OP_LOG_10', { value: VAR('A') }));
rt('e^', IN('OP_POW_E', { value: VAR('A') }));
rt('10^', IN('OP_POW_10', { value: VAR('A') }));
rt('sin', IN('OP_SIN', { value: VAR('A') }));
rt('cos', IN('OP_COS', { value: VAR('A') }));
rt('tan', IN('OP_TAN', { value: VAR('A') }));
rt('asin', IN('OP_ASIN', { value: VAR('A') }));
rt('acos', IN('OP_ACOS', { value: VAR('A') }));
rt('atan', IN('OP_ATAN', { value: VAR('A') }));

// ---- random --------------------------------------------------------------

rt('random (ints)', IN('OP_RANDOM', { low: VAR('A'), high: VAR('B'), useInts: true, useFloats: false }));
rt('random (floats)', IN('OP_RANDOM', { low: VAR('A'), high: VAR('B'), useInts: false, useFloats: true }));
rt('random (runtime decides)', IN('OP_RANDOM', { low: VAR('A'), high: VAR('B'), useInts: false, useFloats: false }));

// ---- nesting -------------------------------------------------------------

rt('sin of cos', IN('OP_SIN', { value: IN('OP_COS', { value: VAR('A') }) }));
rt('round of a division', IN('OP_ROUND', { value: IN('OP_DIVIDE', { left: VAR('A'), right: VAR('B') }) }));
rt('deep arithmetic', IN('OP_ADD', {
  left: IN('OP_MULTIPLY', { left: VAR('A'), right: IN('OP_SUBTRACT', { left: VAR('B'), right: N(2) }) }),
  right: IN('OP_DIVIDE', { left: IN('OP_MOD', { left: VAR('C'), right: N(7) }), right: VAR('D') }),
}));
rt('letter of the join of two lists', IN('OP_LETTER_OF', {
  string: IN('OP_JOIN', { left: IN('LIST_CONTENTS', { list: VB('L1') }, TY().STRING), right: C('!') }),
  letter: IN('LIST_LENGTH', { list: VB('L2') }),
}));
rt('contains between two "of" reporters', IN('OP_CONTAINS', {
  string: AS('SENSING_OF_COSTUME_NAME', TY().STRING, { object: C('Sprite2') }),
  contains: AS('LOOKS_BACKDROP_NAME', TY().STRING),
}));
rt('not of and of two comparisons', IN('OP_NOT', {
  operand: IN('OP_AND', {
    left: IN('OP_LESS', { left: NUMBER(), right: NUMBER_OR_NAN() }),
    right: IN('OP_GREATER', { left: NUMBER_OR_NAN(), right: NUMBER() }),
  }),
}));

// ---- procedure arguments -------------------------------------------------

rt('procedure argument', IN('PROCEDURE_ARGUMENT', { index: 0 }), { args: ['x'], isProcedure: true });
rt('argument inside arithmetic', IN('OP_ADD', {
  left: IN('PROCEDURE_ARGUMENT', { index: 1 }), right: IN('PROCEDURE_ARGUMENT', { index: 0 }),
}), { args: ['x', 'y'], isProcedure: true });
