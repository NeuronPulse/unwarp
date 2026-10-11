/**
 * Round-trip coverage for every reporter (InputOpcode) jsgen can emit.
 * Each case wraps the reporter in `set V1 to <reporter>` so it appears in a stack.
 */
import { roundtrip, ENUMS, C, N, B, COLOR, VB, VAR, IN, SB } from './harness';

const T = () => ENUMS.InputType;
const rt = (name: string, input: any, opts: any = {}) =>
  roundtrip(`input: ${name}`, [SB('VAR_SET', { variable: VB('V1'), value: input })], opts);

// ---- variables & lists ---------------------------------------------------

rt('var.get (target scope)', VAR('V2'));
rt('var.get (stage scope)', IN('VAR_GET', { variable: VB('G1', 'stage') }));
rt('list.get via listGet() (non-numeric index)', IN('LIST_GET', { list: VB('L1'), index: VAR('I') }));
rt('list.get via nullish index', IN('LIST_GET', { list: VB('L1'), index: N(2) }));
rt('list.get "last"', IN('LIST_GET', { list: VB('L1'), index: C('last') }));
rt('list.length', IN('LIST_LENGTH', { list: VB('L1') }));
rt('list.contains', IN('LIST_CONTAINS', { list: VB('L1'), item: C('x') }));
rt('list.indexOf', IN('LIST_INDEX_OF', { list: VB('L1'), item: VAR('V2') }));
rt('list.contents', IN('LIST_CONTENTS', { list: VB('L1') }));
rt('cast.number over boolean constant', IN('CAST_NUMBER', { target: B(true) }));
rt('cast.numberOrNaN over number constant', IN('CAST_NUMBER_OR_NAN', { target: N(3) }));
rt('compat reporter', (() => {
  const compat = IN('COMPATIBILITY_LAYER', {
    opcode: 'ext_reporter', id: 'blkR',
    inputs: { X: VAR('V1') }, fields: { F: 'v' },
  });
  compat.yields = true; // irgen always marks compat inputs as yielding
  return compat;
})());

// ---- looks / motion getters ---------------------------------------------

rt('looks.size', IN('LOOKS_SIZE_GET'));
rt('looks.backdropName', IN('LOOKS_BACKDROP_NAME'));
rt('looks.backdropNumber', IN('LOOKS_BACKDROP_NUMBER'));
rt('looks.costumeName', IN('LOOKS_COSTUME_NAME'));
rt('looks.costumeNumber', IN('LOOKS_COSTUME_NUMBER'));
rt('motion.x', IN('MOTION_X_GET'));
rt('motion.y', IN('MOTION_Y_GET'));
rt('motion.direction', IN('MOTION_DIRECTION_GET'));

// ---- sensing (devices / clock) ------------------------------------------

rt('sensing.mouseDown', IN('SENSING_MOUSE_DOWN'));
rt('sensing.mouseX', IN('SENSING_MOUSE_X'));
rt('sensing.mouseY', IN('SENSING_MOUSE_Y'));
rt('sensing.keyPressed', IN('SENSING_KEY_DOWN', { key: C('space') }));
rt('sensing.answer', IN('SENSING_ANSWER'));
rt('sensing.username', IN('SENSING_USERNAME'));
rt('sensing.timer', IN('SENSING_TIMER_GET'));
rt('tw.lastKeyPressed', IN('TW_KEY_LAST_PRESSED'));
rt('control.counter', IN('CONTROL_COUNTER'));

// ---- sensing (current date/time) ----------------------------------------

rt('sensing.year', IN('SENSING_TIME_YEAR'));
rt('sensing.month', IN('SENSING_TIME_MONTH'));
rt('sensing.date', IN('SENSING_TIME_DATE'));
rt('sensing.dayofweek', IN('SENSING_TIME_WEEKDAY'));
rt('sensing.hour', IN('SENSING_TIME_HOUR'));
rt('sensing.minute', IN('SENSING_TIME_MINUTE'));
rt('sensing.second', IN('SENSING_TIME_SECOND'));
rt('sensing.daysSince2000', IN('SENSING_TIME_DAYS_SINCE_2000'));

// ---- sensing (touching / distance) --------------------------------------

rt('sensing.distance', IN('SENSING_DISTANCE', { target: C('Sprite2') }));
rt('sensing.touching', IN('SENSING_TOUCHING_OBJECT', { object: C('_mouse_') }));
rt('sensing.touchingColor', IN('SENSING_TOUCHING_COLOR', { color: COLOR(1, 2, 3) }));
rt('sensing.colorTouchingColor', IN('SENSING_COLOR_TOUCHING_COLOR', { target: COLOR(1, 2, 3), mask: COLOR(4, 5, 6) }));

// ---- "of" reporters ------------------------------------------------------

rt('sensing.of (generic)', IN('SENSING_OF', { object: C('Sprite2'), property: 'volume' }));
rt('sensing.of.x (named sprite)', IN('SENSING_OF_POS_X', { object: C('Sprite2') }));
rt('sensing.of.x (mouse)', IN('SENSING_OF_POS_X', { object: C('_mouse_') }));
rt('sensing.of.direction (mouse)', IN('SENSING_OF_DIRECTION', { object: C('_mouse_') }));
rt('sensing.of.volume (edge)', IN('SENSING_OF_VOLUME', { object: C('_edge_') }));
rt('sensing.of.y (named sprite)', IN('SENSING_OF_POS_Y', { object: C('Sprite2') }));
rt('sensing.of.direction (named sprite)', IN('SENSING_OF_DIRECTION', { object: C('Sprite2') }));
rt('sensing.of.size (named sprite)', IN('SENSING_OF_SIZE', { object: C('Sprite2') }));
rt('sensing.of.volume (named sprite)', IN('SENSING_OF_VOLUME', { object: C('Sprite2') }));
rt('sensing.of.volume (stage)', IN('SENSING_OF_VOLUME', { object: C('_stage_') }));
rt('sensing.of.costumeNumber', IN('SENSING_OF_COSTUME_NUMBER', { object: C('Sprite2') }));
rt('sensing.of.costumeName', IN('SENSING_OF_COSTUME_NAME', { object: C('Sprite2') }));
rt('sensing.of.backdropNumber (stage)', IN('SENSING_OF_BACKDROP_NUMBER', { object: C('_stage_') }, T().NUMBER_POS_INT));
rt('sensing.of.backdropName (stage)', IN('SENSING_OF_BACKDROP_NAME', { object: C('_stage_') }, T().STRING));
rt('sensing.of.var (named sprite)', IN('SENSING_OF_VAR', { object: C('Sprite2'), property: 'score' }));
rt('sensing.of.var (stage)', IN('SENSING_OF_VAR', { object: C('_stage_'), property: 'score' }));
