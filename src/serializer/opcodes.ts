/**
 * Mapping tables from unwarp's decompiler IR (src/decompiler/ir.ts) back to native
 * Scratch SB3 opcodes / input / field names.
 *
 * The decompiler produces a byte-for-byte faithful IR of what jsgen emitted, so the
 * inverse mapping here is the same relation scratch-vm's own compiler (`irgen`) uses
 * in the forward direction. Any opcode the compiler could emit is representable.
 */

/**
 * Per-reporter spec. `fields` maps an IR input key to the SB3 field name on the block;
 * `inputs` maps an IR input key to the SB3 input name. `constField` marks field values
 * that are read from a CONSTANT input on the IR side (menus, options).
 *
 * `menuInputs` maps an IR input key (a CONSTANT carrying the selected option) to the
 * SB3 input that irgen descends (e.g. `DISTANCETOMENU`) plus the shadow menu block
 * (opcode + field) that must be emitted as that input, since irgen reads these as
 * inputs, not as parent-block fields.
 */
export interface MenuInputSpec {
    /** SB3 input name irgen descends on the parent block. */
    input: string;
    /** Opcode of the shadow menu block. */
    menuOpcode: string;
    /** Field name carrying the value on the menu block. */
    field: string;
}

export interface ReporterSpec {
    opcode: string;
    inputs?: Record<string, string>;
    fields?: Record<string, string>;
    /** IR input keys whose value is a string constant to be stored as a field. */
    constFields?: Record<string, string>;
    /** IR input keys whose value must be emitted as a shadow menu block input. */
    menuInputs?: Record<string, MenuInputSpec>;
    /** Fields whose value is fixed for this opcode. */
    fixedFields?: Record<string, string>;
    /** Field names whose stored value must be uppercased to match scratch-blocks dropdown storage. */
    uppercaseFields?: string[];
    /** SB3 field name for a list reference carried in the IR `list` input key. */
    listField?: string;
    /** SB3 field name for a variable reference carried in the IR `variable` input key. */
    varField?: string;
}

export const REPORTER_SPECS: Record<string, ReporterSpec> = {
    'looks.backdropNumber': { opcode: 'looks_backdropnumbername', fixedFields: { NUMBER_NAME: 'number' } },
    'looks.backdropName': { opcode: 'looks_backdropnumbername', fixedFields: { NUMBER_NAME: 'name' } },
    'looks.costumeNumber': { opcode: 'looks_costumenumbername', fixedFields: { NUMBER_NAME: 'number' } },
    'looks.costumeName': { opcode: 'looks_costumenumbername', fixedFields: { NUMBER_NAME: 'name' } },
    'looks.size': { opcode: 'looks_size' },
    'motion.x': { opcode: 'motion_xposition' },
    'motion.y': { opcode: 'motion_yposition' },
    'motion.direction': { opcode: 'motion_direction' },
    'op.add': { opcode: 'operator_add', inputs: { left: 'NUM1', right: 'NUM2' } },
    'op.subtract': { opcode: 'operator_subtract', inputs: { left: 'NUM1', right: 'NUM2' } },
    'op.multiply': { opcode: 'operator_multiply', inputs: { left: 'NUM1', right: 'NUM2' } },
    'op.divide': { opcode: 'operator_divide', inputs: { left: 'NUM1', right: 'NUM2' } },
    'op.mod': { opcode: 'operator_mod', inputs: { left: 'NUM1', right: 'NUM2' } },
    'op.random': { opcode: 'operator_random', inputs: { left: 'FROM', right: 'TO' } },
    'op.greater': { opcode: 'operator_gt', inputs: { left: 'OPERAND1', right: 'OPERAND2' } },
    'op.less': { opcode: 'operator_lt', inputs: { left: 'OPERAND1', right: 'OPERAND2' } },
    'op.equals': { opcode: 'operator_equals', inputs: { left: 'OPERAND1', right: 'OPERAND2' } },
    'op.and': { opcode: 'operator_and', inputs: { left: 'OPERAND1', right: 'OPERAND2' } },
    'op.or': { opcode: 'operator_or', inputs: { left: 'OPERAND1', right: 'OPERAND2' } },
    'op.not': { opcode: 'operator_not', inputs: { operand: 'OPERAND' } },
    'op.join': { opcode: 'operator_join', inputs: { left: 'STRING1', right: 'STRING2' } },
    'op.contains': { opcode: 'operator_contains', inputs: { left: 'STRING1', right: 'STRING2' } },
    'op.length': { opcode: 'operator_length', inputs: { string: 'STRING' } },
    'op.letterOf': { opcode: 'operator_letter_of', inputs: { letter: 'LETTER', string: 'STRING' } },
    'op.round': { opcode: 'operator_round', inputs: { value: 'NUM' } },
    'op.abs': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'abs' } },
    'op.floor': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'floor' } },
    'op.ceiling': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'ceiling' } },
    'op.sqrt': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'sqrt' } },
    'op.sin': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'sin' } },
    'op.cos': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'cos' } },
    'op.tan': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'tan' } },
    'op.asin': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'asin' } },
    'op.acos': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'acos' } },
    'op.atan': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'atan' } },
    'op.ln': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'ln' } },
    'op.log': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'log' } },
    'op.e^': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: 'e ^' } },
    'op.10^': { opcode: 'operator_mathop', inputs: { value: 'NUM' }, fixedFields: { OPERATOR: '10 ^' } },
    'sensing.answer': { opcode: 'sensing_answer' },
    'sensing.year': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'YEAR' } },
    'sensing.month': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'MONTH' } },
    'sensing.date': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'DATE' } },
    'sensing.dayofweek': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'DAYOFWEEK' } },
    'sensing.hour': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'HOUR' } },
    'sensing.minute': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'MINUTE' } },
    'sensing.second': { opcode: 'sensing_current', fixedFields: { CURRENTMENU: 'SECOND' } },
    'sensing.daysSince2000': { opcode: 'sensing_dayssince2000' },
    'sensing.distance': {
        opcode: 'sensing_distanceto',
        menuInputs: { target: { input: 'DISTANCETOMENU', menuOpcode: 'sensing_distancetomenu', field: 'DISTANCETOMENU' } },
        inputs: { target: 'DISTANCETOMENU' },
    },
    'keyboard.pressed': {
        opcode: 'sensing_keypressed',
        menuInputs: { key: { input: 'KEY_OPTION', menuOpcode: 'sensing_keyoptions', field: 'KEY_OPTION' } },
        inputs: { key: 'KEY_OPTION' },
    },
    'mouse.down': { opcode: 'sensing_mousedown' },
    'mouse.x': { opcode: 'sensing_mousex' },
    'mouse.y': { opcode: 'sensing_mousey' },
    'timer.get': { opcode: 'sensing_timer' },
    'sensing.username': { opcode: 'sensing_username' },
    'sensing.touchingColor': { opcode: 'sensing_touchingcolor', inputs: { color: 'COLOR' } },
    'sensing.colorTouchingColor': { opcode: 'sensing_coloristouchingcolor', inputs: { target: 'COLOR', mask: 'COLOR2' } },
    'sensing.touching': {
        opcode: 'sensing_touchingobject',
        menuInputs: { object: { input: 'TOUCHINGOBJECTMENU', menuOpcode: 'sensing_touchingobjectmenu', field: 'TOUCHINGOBJECTMENU' } },
        inputs: { object: 'TOUCHINGOBJECTMENU' },
    },
    'list.get': { opcode: 'data_itemoflist', listField: 'LIST', inputs: { index: 'INDEX' } },
    'list.length': { opcode: 'data_lengthoflist', listField: 'LIST' },
    'list.contains': { opcode: 'data_listcontainsitem', listField: 'LIST', inputs: { item: 'ITEM' } },
    'list.indexOf': { opcode: 'data_itemnumoflist', listField: 'LIST', inputs: { item: 'ITEM' } },
    'control.counter': { opcode: 'control_get_counter' },
    'tw.lastKeyPressed': { opcode: 'sensing_lastkeypressed' },
    'procedures.argument': { opcode: 'argument_reporter_string_number' },
};

/**
 * Per-stack-block spec. In addition to ReporterSpec fields:
 *  - `substacks` maps an IR input key to the SB3 C-shaped input name.
 *  - `listField` / `varField` name the SB3 field that a list/variable reference input
 *    is stored into.
 */
export interface StackSpec extends ReporterSpec {
    substacks?: Record<string, string>;
    listField?: string;
    varField?: string;
}

export const STACK_SPECS: Record<string, StackSpec> = {
    'control.if': { opcode: 'control_if_else', inputs: { condition: 'CONDITION' }, substacks: { whenTrue: 'SUBSTACK', whenFalse: 'SUBSTACK2' } },
    // Not a real IR opcode: irgen compiles `control_if` to CONTROL_IF_ELSE with an empty
    // `whenFalse`, so the serializer picks this form to recover the plain "if" block.
    'control.if.only': { opcode: 'control_if', inputs: { condition: 'CONDITION' }, substacks: { whenTrue: 'SUBSTACK' } },
    // Not a real IR opcode: irgen compiles `control_forever` to CONTROL_WHILE with a constant
    // `true` condition, i.e. `while (true)`.
    'control.forever': { opcode: 'control_forever', substacks: { do: 'SUBSTACK' } },
    // Not a real IR opcode: irgen compiles `control_repeat_until` to CONTROL_WHILE + OP_NOT.
    'control.repeatUntil': { opcode: 'control_repeat_until', inputs: { condition: 'CONDITION' }, substacks: { do: 'SUBSTACK' } },
    'control.createClone': {
        opcode: 'control_create_clone_of',
        menuInputs: { target: { input: 'CLONE_OPTION', menuOpcode: 'control_create_clone_of_menu', field: 'CLONE_OPTION' } },
        inputs: { target: 'CLONE_OPTION' },
    },
    'control.deleteClone': { opcode: 'control_delete_this_clone' },
    'control.while': { opcode: 'control_while', inputs: { condition: 'CONDITION' }, substacks: { do: 'SUBSTACK' } },
    'control.for': { opcode: 'control_for_each', varField: 'VARIABLE', inputs: { count: 'VALUE' }, substacks: { do: 'SUBSTACK' } },
    'control.repeat': { opcode: 'control_repeat', inputs: { times: 'TIMES' }, substacks: { do: 'SUBSTACK' } },
    'control.stopAll': { opcode: 'control_stop', fixedFields: { STOP_OPTION: 'all' } },
    'control.stopOthers': { opcode: 'control_stop', fixedFields: { STOP_OPTION: 'other scripts in sprite' } },
    'control.stopScript': { opcode: 'control_stop', fixedFields: { STOP_OPTION: 'this script' } },
    'control.wait': { opcode: 'control_wait', inputs: { seconds: 'DURATION' } },
    'control.waitUntil': { opcode: 'control_wait_until', inputs: { condition: 'CONDITION' } },
    'control.counterClear': { opcode: 'control_clear_counter' },
    'control.counterIncr': { opcode: 'control_incr_counter' },

    'list.add': { opcode: 'data_addtolist', listField: 'LIST', inputs: { item: 'ITEM' } },
    'list.instert': { opcode: 'data_insertatlist', listField: 'LIST', inputs: { index: 'INDEX', item: 'ITEM' } },
    'list.replace': { opcode: 'data_replaceitemoflist', listField: 'LIST', inputs: { index: 'INDEX', item: 'ITEM' } },
    'list.deleteAll': { opcode: 'data_deletealloflist', listField: 'LIST' },
    'list.delete': { opcode: 'data_deleteoflist', listField: 'LIST', inputs: { index: 'INDEX' } },
    'list.show': { opcode: 'data_showlist', listField: 'LIST' },
    'list.hide': { opcode: 'data_hidelist', listField: 'LIST' },

    'var.set': { opcode: 'data_setvariableto', varField: 'VARIABLE', inputs: { value: 'VALUE' } },
    // Not a real IR opcode: irgen lowers `change variable by` to VAR_SET(X, OP_ADD(VAR_GET(X), n)),
    // which is byte-identical to a hand-written `set X to (X + n)`, so the serializer picks this
    // form to recover the single "change" block instead of a set + an add.
    'var.set.change': { opcode: 'data_changevariableby', varField: 'VARIABLE', inputs: { value: 'VALUE' } },
    'var.show': { opcode: 'data_showvariable', varField: 'VARIABLE' },
    'var.hide': { opcode: 'data_hidevariable', varField: 'VARIABLE' },

    'looks.setEffect': { opcode: 'looks_seteffectto', constFields: { effect: 'EFFECT' }, inputs: { value: 'VALUE' }, uppercaseFields: ['EFFECT'] },
    'looks.changeEffect': { opcode: 'looks_changeeffectby', constFields: { effect: 'EFFECT' }, inputs: { value: 'CHANGE' }, uppercaseFields: ['EFFECT'] },
    'looks.clearEffects': { opcode: 'looks_cleargraphiceffects' },
    'looks.changeSize': { opcode: 'looks_changesizeby', inputs: { size: 'CHANGE' } },
    'looks.setSize': { opcode: 'looks_setsizeto', inputs: { size: 'SIZE' } },
    'looks.forwardLayers': { opcode: 'looks_goforwardbackwardlayers', fixedFields: { FORWARD_BACKWARD: 'forward' }, inputs: { layers: 'NUM' } },
    'looks.backwardLayers': { opcode: 'looks_goforwardbackwardlayers', fixedFields: { FORWARD_BACKWARD: 'backward' }, inputs: { layers: 'NUM' } },
    'looks.goToFront': { opcode: 'looks_gotofrontback', fixedFields: { FRONT_BACK: 'front' } },
    'looks.goToBack': { opcode: 'looks_gotofrontback', fixedFields: { FRONT_BACK: 'back' } },
    'looks.hide': { opcode: 'looks_hide' },
    'looks.show': { opcode: 'looks_show' },
    'looks.nextBackdrop': { opcode: 'looks_nextbackdrop' },
    'looks.switchBackdrop': { opcode: 'looks_switchbackdropto', inputs: { backdrop: 'BACKDROP' } },
    'looks.nextCostume': { opcode: 'looks_nextcostume' },
    'looks.switchCostume': { opcode: 'looks_switchcostumeto', inputs: { costume: 'COSTUME' } },
    'looks.say': { opcode: 'looks_say', inputs: { message: 'MESSAGE' } },
    'looks.think': { opcode: 'looks_think', inputs: { message: 'MESSAGE' } },

    'motion.setX': { opcode: 'motion_setx', inputs: { x: 'X' } },
    'motion.changeX': { opcode: 'motion_changexby', inputs: { dx: 'DX' } },
    'motion.setY': { opcode: 'motion_sety', inputs: { y: 'Y' } },
    'motion.changeY': { opcode: 'motion_changeyby', inputs: { dy: 'DY' } },
    'motion.setXY': { opcode: 'motion_gotoxy', inputs: { x: 'X', y: 'Y' } },
    'motion.ifOnEdgeBounce': { opcode: 'motion_ifonedgebounce' },
    'motion.step': { opcode: 'motion_movesteps', inputs: { steps: 'STEPS' } },
    'motion.setRotationStyle': { opcode: 'motion_setrotationstyle', constFields: { style: 'STYLE' } },
    'motion.setDirection': { opcode: 'motion_pointindirection', inputs: { direction: 'DIRECTION' } },

    'timer.reset': { opcode: 'sensing_resettimer' },

    'pen.up': { opcode: 'pen_penUp' },
    'pen.down': { opcode: 'pen_penDown' },
    'pen.clear': { opcode: 'pen_clear' },
    'pen.setParam': {
        opcode: 'pen_setPenColorParamTo',
        menuInputs: { param: { input: 'COLOR_PARAM', menuOpcode: 'pen_menu_colorParam', field: 'COLOR_PARAM' } },
        inputs: { value: 'VALUE', param: 'COLOR_PARAM' },
    },
    'pen.changeParam': {
        opcode: 'pen_changePenColorParamBy',
        menuInputs: { param: { input: 'COLOR_PARAM', menuOpcode: 'pen_menu_colorParam', field: 'COLOR_PARAM' } },
        inputs: { value: 'VALUE', param: 'COLOR_PARAM' },
    },
    'pen.legacyChangeHue': { opcode: 'pen_changePenHueBy', inputs: { hue: 'HUE' } },
    'pen_setPenHueToNumber': { opcode: 'pen_setPenHueToNumber', inputs: { hue: 'HUE' } },
    'pen.legacyChangeShade': { opcode: 'pen_changePenShadeBy', inputs: { shade: 'SHADE' } },
    'pen.legacySetShade': { opcode: 'pen_setPenShadeToNumber', inputs: { shade: 'SHADE' } },
    'pen.setColor': { opcode: 'pen_setPenColorToColor', inputs: { color: 'COLOR' } },
    'pen.setSize': { opcode: 'pen_setPenSizeTo', inputs: { size: 'SIZE' } },
    'pen.changeSize': { opcode: 'pen_changePenSizeBy', inputs: { size: 'SIZE' } },
    'pen.stamp': { opcode: 'pen_stamp' },

    'procedures.return': { opcode: 'procedures_return', inputs: { value: 'VALUE' } },
};
