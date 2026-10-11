/**
 * Self-contained definitions mirroring scratch-vm/src/compiler/{intermediate,enums}.js.
 *
 * We deliberately DO NOT require scratch-vm here: intermediate.js pulls in runtime
 * dependencies (@turbowarp/nanolog, util/log, ...) that the decompiler does not need.
 * The node shapes and enums below are byte-for-byte compatible with what jsgen consumes,
 * so the IR produced here can later be fed to an IR -> project.json serializer unchanged.
 */

export const InputType = {
    NUMBER_POS_INF: 0x001,
    NUMBER_POS_INT: 0x002,
    NUMBER_POS_FRACT: 0x004,
    NUMBER_POS_REAL: 0x006,
    NUMBER_ZERO: 0x008,
    NUMBER_NEG_ZERO: 0x010,
    NUMBER_NEG_INT: 0x020,
    NUMBER_NEG_FRACT: 0x040,
    NUMBER_NEG_REAL: 0x060,
    NUMBER_NEG_INF: 0x080,
    NUMBER_NAN: 0x100,
    NUMBER_ANY_ZERO: 0x018,
    NUMBER_INF: 0x081,
    NUMBER_POS: 0x007,
    NUMBER_NEG: 0x0E0,
    NUMBER_WHOLE: 0x00A,
    NUMBER_INT: 0x03A,
    NUMBER_INDEX: 0x1BB,
    NUMBER_FRACT: 0x44,
    NUMBER_REAL: 0x07E,
    NUMBER: 0x0FF,
    NUMBER_OR_NAN: 0x1FF,
    NUMBER_INTERPRETABLE: 0x12FF,
    STRING_NUM: 0x200,
    STRING_NAN: 0x400,
    STRING_BOOLEAN: 0x800,
    STRING: 0xE00,
    BOOLEAN: 0x1000,
    BOOLEAN_INTERPRETABLE: 0x1800,
    ANY: 0x1FFF,
    COLOR: 0x2000,
};

export const StackOpcode = {
    NOP: 'noop',
    ADDON_CALL: 'addons.call',
    DEBUGGER: 'tw.debugger',
    VISUAL_REPORT: 'visualReport',
    COMPATIBILITY_LAYER: 'compat',
    OLD_COMPILER_COMPATIBILITY_LAYER: 'oldCompiler',
    HAT_EDGE: 'hat.edge',
    HAT_PREDICATE: 'hat.predicate',
    CONTROL_IF_ELSE: 'control.if',
    CONTROL_CLONE_CREATE: 'control.createClone',
    CONTROL_CLONE_DELETE: 'control.deleteClone',
    CONTROL_WHILE: 'control.while',
    CONTROL_FOR: 'control.for',
    CONTROL_REPEAT: 'control.repeat',
    CONTROL_STOP_ALL: 'control.stopAll',
    CONTROL_STOP_OTHERS: 'control.stopOthers',
    CONTROL_STOP_SCRIPT: 'control.stopScript',
    CONTROL_WAIT: 'control.wait',
    CONTROL_WAIT_UNTIL: 'control.waitUntil',
    CONTROL_CLEAR_COUNTER: 'control.counterClear',
    CONTORL_INCR_COUNTER: 'control.counterIncr',
    LIST_ADD: 'list.add',
    LIST_INSERT: 'list.instert',
    LIST_REPLACE: 'list.replace',
    LIST_DELETE_ALL: 'list.deleteAll',
    LIST_DELETE: 'list.delete',
    LIST_SHOW: 'list.show',
    LIST_HIDE: 'list.hide',
    VAR_SET: 'var.set',
    VAR_SHOW: 'var.show',
    VAR_HIDE: 'var.hide',
    EVENT_BROADCAST: 'event.broadcast',
    EVENT_BROADCAST_AND_WAIT: 'event.broadcastAndWait',
    LOOKS_EFFECT_SET: 'looks.setEffect',
    LOOKS_EFFECT_CHANGE: 'looks.changeEffect',
    LOOKS_EFFECT_CLEAR: 'looks.clearEffects',
    LOOKS_SIZE_CHANGE: 'looks.changeSize',
    LOOKS_SIZE_SET: 'looks.setSize',
    LOOKS_LAYER_FORWARD: 'looks.forwardLayers',
    LOOKS_LAYER_BACKWARD: 'looks.backwardLayers',
    LOOKS_LAYER_FRONT: 'looks.goToFront',
    LOOKS_LAYER_BACK: 'looks.goToBack',
    LOOKS_HIDE: 'looks.hide',
    LOOKS_SHOW: 'looks.show',
    LOOKS_BACKDROP_NEXT: 'looks.nextBackdrop',
    LOOKS_BACKDROP_SET: 'looks.switchBackdrop',
    LOOKS_COSTUME_NEXT: 'looks.nextCostume',
    LOOKS_COSTUME_SET: 'looks.switchCostume',
    LOOKS_SAY: 'looks.say',
    LOOKS_THINK: 'looks.think',
    MOTION_X_SET: 'motion.setX',
    MOTION_X_CHANGE: 'motion.changeX',
    MOTION_Y_SET: 'motion.setY',
    MOTION_Y_CHANGE: 'motion.changeY',
    MOTION_XY_SET: 'motion.setXY',
    MOTION_IF_ON_EDGE_BOUNCE: 'motion.ifOnEdgeBounce',
    MOTION_STEP: 'motion.step',
    MOTION_ROTATION_STYLE_SET: 'motion.setRotationStyle',
    MOTION_DIRECTION_SET: 'motion.setDirection',
    PEN_UP: 'pen.up',
    PEN_DOWN: 'pen.down',
    PEN_CLEAR: 'pen.clear',
    PEN_COLOR_PARAM_SET: 'pen.setParam',
    PEN_COLOR_PARAM_CHANGE: 'pen.changeParam',
    PEN_COLOR_HUE_CHANGE_LEGACY: 'pen.legacyChangeHue',
    PEN_COLOR_HUE_SET_LEGACY: 'pen_setPenHueToNumber',
    PEN_COLOR_SHADE_CHANGE_LEGACY: 'pen.legacyChangeShade',
    PEN_COLOR_SHADE_SET_LEGACY: 'pen.legacySetShade',
    PEN_COLOR_SET: 'pen.setColor',
    PEN_SIZE_SET: 'pen.setSize',
    PEN_SIZE_CHANGE: 'pen.changeSize',
    PEN_STAMP: 'pen.stamp',
    SENSING_TIMER_RESET: 'timer.reset',
    PROCEDURE_RETURN: 'procedures.return',
    PROCEDURE_CALL: 'procedures.call',
};

export const InputOpcode = {
    NOP: 'noop',
    ADDON_CALL: 'addons.call',
    CONSTANT: 'constant',
    CAST_NUMBER: 'cast.toNumber',
    CAST_NUMBER_INDEX: 'cast.toInteger',
    CAST_NUMBER_OR_NAN: 'cast.toNumberOrNaN',
    CAST_STRING: 'cast.toString',
    CAST_BOOLEAN: 'cast.toBoolean',
    CAST_COLOR: 'cast.toColor',
    COMPATIBILITY_LAYER: 'compat',
    OLD_COMPILER_COMPATIBILITY_LAYER: 'oldCompiler',
    LOOKS_BACKDROP_NUMBER: 'looks.backdropNumber',
    LOOKS_BACKDROP_NAME: 'looks.backdropName',
    LOOKS_COSTUME_NUMBER: 'looks.costumeNumber',
    LOOKS_COSTUME_NAME: 'looks.costumeName',
    LOOKS_SIZE_GET: 'looks.size',
    VAR_GET: 'var.get',
    LIST_GET: 'list.get',
    LIST_LENGTH: 'list.length',
    LIST_CONTAINS: 'list.contains',
    LIST_INDEX_OF: 'list.indexOf',
    LIST_CONTENTS: 'list.contents',
    MOTION_X_GET: 'motion.x',
    MOTION_Y_GET: 'motion.y',
    MOTION_DIRECTION_GET: 'motion.direction',
    OP_ADD: 'op.add',
    OP_AND: 'op.and',
    OP_CONTAINS: 'op.contains',
    OP_DIVIDE: 'op.divide',
    OP_EQUALS: 'op.equals',
    OP_GREATER: 'op.greater',
    OP_LESS: 'op.less',
    OP_JOIN: 'op.join',
    OP_LENGTH: 'op.length',
    OP_LETTER_OF: 'op.letterOf',
    OP_ABS: 'op.abs',
    OP_FLOOR: 'op.floor',
    OP_CEILING: 'op.ceiling',
    OP_SQRT: 'op.sqrt',
    OP_SIN: 'op.sin',
    OP_COS: 'op.cos',
    OP_TAN: 'op.tan',
    OP_ASIN: 'op.asin',
    OP_ACOS: 'op.acos',
    OP_ATAN: 'op.atan',
    OP_LOG_E: 'op.ln',
    OP_LOG_10: 'op.log',
    OP_POW_E: 'op.e^',
    OP_POW_10: 'op.10^',
    OP_MOD: 'op.mod',
    OP_MULTIPLY: 'op.multiply',
    OP_NOT: 'op.not',
    OP_OR: 'op.or',
    OP_RANDOM: 'op.random',
    OP_ROUND: 'op.round',
    OP_SUBTRACT: 'op.subtract',
    SENSING_ANSWER: 'sensing.answer',
    SENSING_COLOR_TOUCHING_COLOR: 'sensing.colorTouchingColor',
    SENSING_TIME_YEAR: 'sensing.year',
    SENSING_TIME_MONTH: 'sensing.month',
    SENSING_TIME_DATE: 'sensing.date',
    SENSING_TIME_WEEKDAY: 'sensing.dayofweek',
    SENSING_TIME_HOUR: 'sensing.hour',
    SENSING_TIME_MINUTE: 'sensing.minute',
    SENSING_TIME_SECOND: 'sensing.second',
    SENSING_TIME_DAYS_SINCE_2000: 'sensing.daysSince2000',
    SENSING_DISTANCE: 'sensing.distance',
    SENSING_KEY_DOWN: 'keyboard.pressed',
    SENSING_MOUSE_DOWN: 'mouse.down',
    SENSING_MOUSE_X: 'mouse.x',
    SENSING_MOUSE_Y: 'mouse.y',
    SENSING_OF: 'sensing.of',
    SENSING_OF_BACKDROP_NAME: 'sensing.of.backdropName',
    SENSING_OF_BACKDROP_NUMBER: 'sensing.of.backdropNumber',
    SENSING_OF_COSTUME_NAME: 'sensing.of.costumeName',
    SENSING_OF_COSTUME_NUMBER: 'sensing.of.costumeNumber',
    SENSING_OF_VOLUME: 'sensing.of.volume',
    SENSING_OF_POS_X: 'sensing.of.x',
    SENSING_OF_POS_Y: 'sensing.of.y',
    SENSING_OF_DIRECTION: 'sensing.of.direction',
    SENSING_OF_SIZE: 'sensing.of.size',
    SENSING_OF_VAR: 'sensing.of.var',
    SENSING_TIMER_GET: 'timer.get',
    SENSING_TOUCHING_COLOR: 'sensing.touchingColor',
    SENSING_TOUCHING_OBJECT: 'sensing.touching',
    SENSING_USERNAME: 'sensing.username',
    PROCEDURE_CALL: 'procedures.call',
    PROCEDURE_ARGUMENT: 'procedures.argument',
    CONTROL_COUNTER: 'control.counter',
    TW_KEY_LAST_PRESSED: 'tw.lastKeyPressed',
};

export class IntermediateInput {
    opcode: string;
    type: number;
    inputs: Record<string, any>;
    yields: boolean;

    static getNumberInputType(number: number): number {
        if (typeof number !== 'number') throw new Error('Expected a number.');
        if (number === Infinity) return InputType.NUMBER_POS_INF;
        if (number === -Infinity) return InputType.NUMBER_NEG_INF;
        if (number < 0) return Number.isInteger(number) ? InputType.NUMBER_NEG_INT : InputType.NUMBER_NEG_FRACT;
        if (number > 0) return Number.isInteger(number) ? InputType.NUMBER_POS_INT : InputType.NUMBER_POS_FRACT;
        if (Number.isNaN(number)) return InputType.NUMBER_NAN;
        if (Object.is(number, -0)) return InputType.NUMBER_NEG_ZERO;
        return InputType.NUMBER_ZERO;
    }

    constructor(opcode: string, type: number, inputs: Record<string, any> = {}, yields = false) {
        this.opcode = opcode;
        this.type = type;
        this.inputs = inputs;
        this.yields = yields;
    }

    isConstant(value: any): boolean {
        if (this.opcode !== InputOpcode.CONSTANT) return false;
        let equal = this.inputs.value === value;
        if (!equal && typeof value === 'number') equal = (+this.inputs.value) === value;
        return equal;
    }

    isAlwaysType(type: number): boolean {
        return (this.type & type) === this.type;
    }

    isSometimesType(type: number): boolean {
        return (this.type & type) !== 0;
    }
}

export class IntermediateStackBlock {
    opcode: string;
    inputs: Record<string, any>;
    yields: boolean;
    ignoreState: boolean;
    entryState: any;
    exitState: any;

    constructor(opcode: string, inputs: Record<string, any> = {}, yields = false) {
        this.opcode = opcode;
        this.inputs = inputs;
        this.yields = yields;
        this.ignoreState = false;
        this.entryState = null;
        this.exitState = null;
    }
}

export class IntermediateStack {
    blocks: any[];
    constructor(blocks?: any[]) {
        this.blocks = blocks ?? [];
    }
}

export class IntermediateScript {
    topBlockId: string | null;
    stack: IntermediateStack | null;
    isProcedure: boolean;
    procedureVariant: string;
    procedureCode: string;
    arguments: string[];
    isWarp: boolean;
    yields: boolean;
    warpTimer: boolean;
    dependedProcedures: string[];
    cachedCompileResult: any;
    cachedAnalysisEndState: any;
    executableHat: boolean;

    constructor() {
        this.topBlockId = null;
        this.stack = null;
        this.isProcedure = false;
        this.procedureVariant = '';
        this.procedureCode = '';
        this.arguments = [];
        this.isWarp = false;
        this.yields = true;
        this.warpTimer = false;
        this.dependedProcedures = [];
        this.cachedCompileResult = null;
        this.cachedAnalysisEndState = null;
        this.executableHat = false;
    }
}

export class IntermediateRepresentation {
    entry: IntermediateScript;
    procedures: Record<string, IntermediateScript>;

    constructor(entry: IntermediateScript, procedures: Record<string, IntermediateScript>) {
        this.entry = entry;
        this.procedures = procedures;
    }

    getProcedure(proccode: string): IntermediateScript | undefined {
        return Object.values(this.procedures).find(p => p.procedureCode === proccode);
    }
}
