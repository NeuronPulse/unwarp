/**
 * Generate a deterministic test project with COMPLEX block structures to stress the
 * 02packager obfuscation + unwarp decompile pipeline at every level.
 *
 * Structures exercised:
 *  - custom block with a numeric argument (Walpha %n)
 *  - custom block with a string argument (Wbeta %s)
 *  - custom block with NO arguments (Wgamma) whose body is a chain of SEQUENTIAL ifs
 *    (the Lisp-tokenizer pattern that javascript-obfuscator's `simplify` collapses)
 *  - if/else, repeat, repeat-until, forever loops
 *  - nested procedure calls (Walpha -> Wbeta -> Wgamma)
 *  - list operations (add, length, length-of-list in arithmetic)
 *  - set / change variable
 *
 * The project is fully deterministic (no randomness, no timer dependency) so the
 * behavioral-equivalence checker can compare it frame-for-frame.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type InputVal = [number, any]; // [type, literal-array | blockId]

class B {
    static n = 0;
    readonly id: string;
    opcode = '';
    parent: string | null = null;
    next: string | null = null;
    inputs: Record<string, InputVal> = {};
    fields: Record<string, any> = {};
    shadow = false;
    topLevel = false;
    x = 50;
    y = 50;
    constructor() { this.id = `b${++B.n}`; }
}

const blocks: Record<string, B> = {};

function blk(opcode: string): B {
    const b = new B();
    b.opcode = opcode;
    blocks[b.id] = b;
    return b;
}

/** Inline literal input: [1, [litType, value]]. */
function lit(type: number, value: any): InputVal { return [1, [type, value]]; }
const num = (v: number): InputVal => lit(4, v);
const str = (v: string): InputVal => lit(10, v);

/** Block-pointer input: [2, blockId]. */
function ptr(blockId: string): InputVal { return [2, blockId]; }

/** A data_variable shadow block for variable `name` (id `vid`). */
function varRef(vid: string, name: string): string {
    const v = blk('data_variable');
    v.shadow = true;
    v.fields = { VARIABLE: [name, vid] };
    return v.id;
}
/** A data_listcontents shadow block. */
function listRef(lid: string, name: string): string {
    const l = blk('data_listcontents');
    l.shadow = true;
    l.fields = { LIST: [name, lid] };
    return l.id;
}

// ---------------------------------------------------------------------------
// Variables / lists
// ---------------------------------------------------------------------------
const G_VAR = 'varG'; // stage variable "G"
const L_LIST = 'listL'; // stage list "L"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const ASSET = crypto.createHash('md5').update(SVG).digest('hex'); // real md5 -> compiler preserves assetId

const stage: any = {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{ name: 'costume1', dataFormat: 'svg', md5ext: ASSET + '.svg', assetId: ASSET, rotationCenterX: 0, rotationCenterY: 0 }],
    sounds: [],
    layerOrder: 0,
    volume: 100,
};

// ---------------------------------------------------------------------------
// Sprite "Sprite1"
// ---------------------------------------------------------------------------
const sprite: any = {
    isStage: false,
    name: 'Sprite1',
    variables: { [G_VAR]: ['G', 0] },
    lists: { [L_LIST]: ['L', []] },
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{ name: 'costume1', dataFormat: 'svg', md5ext: ASSET + '.svg', assetId: ASSET, rotationCenterX: 0, rotationCenterY: 0 }],
    sounds: [],
    layerOrder: 1,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
};

// === Wgamma (no args): sequential if chain + loop ===
// set G to 0
const gw_set0 = blk('data_setvariableto'); gw_set0.inputs = { VALUE: num(0) }; gw_set0.fields = { VARIABLE: ['G', G_VAR] };
// if <letter 1 of "hello" = "a"> then change G by 1
const gw_if1 = blk('control_if');
const gw_c1 = blk('operator_equals');
const gw_letter1 = blk('operator_letter_of'); gw_letter1.inputs = { STRING: str('hello'), LETTER: num(1) };
gw_c1.inputs = { OPERAND1: ptr(gw_letter1.id), OPERAND2: str('a') };
const gw_ch1 = blk('data_changevariableby'); gw_ch1.inputs = { VALUE: num(1) }; gw_ch1.fields = { VARIABLE: ['G', G_VAR] };
// if <letter 1 of "hello" = "e"> then change G by 2
const gw_if2 = blk('control_if');
const gw_c2 = blk('operator_equals');
const gw_letter2 = blk('operator_letter_of'); gw_letter2.inputs = { STRING: str('hello'), LETTER: num(1) };
gw_c2.inputs = { OPERAND1: ptr(gw_letter2.id), OPERAND2: str('e') };
const gw_ch2 = blk('data_changevariableby'); gw_ch2.inputs = { VALUE: num(2) }; gw_ch2.fields = { VARIABLE: ['G', G_VAR] };
// if <letter 1 of "hello" = "o"> then change G by 3
const gw_if3 = blk('control_if');
const gw_c3 = blk('operator_equals');
const gw_letter3 = blk('operator_letter_of'); gw_letter3.inputs = { STRING: str('hello'), LETTER: num(1) };
gw_c3.inputs = { OPERAND1: ptr(gw_letter3.id), OPERAND2: str('o') };
const gw_ch3 = blk('data_changevariableby'); gw_ch3.inputs = { VALUE: num(3) }; gw_ch3.fields = { VARIABLE: ['G', G_VAR] };
// repeat 5 { if <G > 0> then change G by 1 }
const gw_repeat = blk('control_repeat'); gw_repeat.inputs = { TIMES: num(5) };
const gw_if4 = blk('control_if');
const gw_c4 = blk('operator_gt'); gw_c4.inputs = { OPERAND1: ptr(varRef(G_VAR, 'G')), OPERAND2: num(0) };
const gw_ch4 = blk('data_changevariableby'); gw_ch4.inputs = { VALUE: num(1) }; gw_ch4.fields = { VARIABLE: ['G', G_VAR] };
// set G to (G + length of L)
const gw_setfinal = blk('data_setvariableto'); gw_setfinal.fields = { VARIABLE: ['G', G_VAR] };
const gw_len2 = blk('data_lengthoflist'); gw_len2.fields = { LIST: ['L', L_LIST] };
const gw_expr = blk('operator_add'); gw_expr.inputs = { NUM1: ptr(varRef(G_VAR, 'G')), NUM2: ptr(gw_len2.id) };

// link Wgamma body
gw_set0.next = gw_if1.id;
gw_if1.inputs.CONDITION = ptr(gw_c1.id); gw_if1.inputs.SUBSTACK = ptr(gw_ch1.id); gw_if1.next = gw_if2.id;
gw_if2.inputs.CONDITION = ptr(gw_c2.id); gw_if2.inputs.SUBSTACK = ptr(gw_ch2.id); gw_if2.next = gw_if3.id;
gw_if3.inputs.CONDITION = ptr(gw_c3.id); gw_if3.inputs.SUBSTACK = ptr(gw_ch3.id); gw_if3.next = gw_repeat.id;
gw_repeat.inputs.SUBSTACK = ptr(gw_if4.id); gw_repeat.next = gw_setfinal.id;
gw_if4.inputs.CONDITION = ptr(gw_c4.id); gw_if4.inputs.SUBSTACK = ptr(gw_ch4.id);
gw_setfinal.inputs.VALUE = ptr(gw_expr.id);

// Wgamma definition + prototype (no args)
const defC = blk('procedures_definition'); defC.topLevel = true; defC.parent = null;
const protoC = blk('procedures_prototype'); protoC.shadow = true; protoC.parent = defC.id;
protoC.inputs = {};
protoC.mutation = {
    tagName: 'mutation', children: [], proccode: 'Wgamma', argumentids: JSON.stringify([]),
    argumentnames: JSON.stringify([]), argumentdefaults: JSON.stringify([]), warp: 'false',
};
defC.inputs = { custom_block: [1, protoC.id] };
defC.next = gw_set0.id;
gw_set0.parent = defC.id;

// === Wbeta %s ===
const defB = blk('procedures_definition'); defB.topLevel = true;
const protoB = blk('procedures_prototype'); protoB.shadow = true; protoB.parent = defB.id;
const bw_argId = 'b0';
const argB0 = blk('argument_reporter_string_number'); argB0.shadow = true; argB0.fields = { VALUE: ['arg0'] };
protoB.inputs = { [bw_argId]: [1, argB0.id] };
argB0.parent = protoB.id;
protoB.mutation = {
    tagName: 'mutation', children: [], proccode: 'Wbeta %s', argumentids: JSON.stringify([bw_argId]),
    argumentnames: JSON.stringify(['arg0']), argumentdefaults: JSON.stringify(['']), warp: 'false',
};
defB.inputs = { custom_block: [1, protoB.id] };

// add arg0 to L
const bw_add = blk('data_addtolist');
bw_add.inputs = { ITEM: ptr(argB0.id) };
bw_add.fields = { LIST: ['L', L_LIST] };
// repeat until <length of L = 5> { add "x" to L }
const bw_ru = blk('control_repeat_until');
const bw_cond = blk('operator_equals');
const bw_len = blk('data_lengthoflist'); bw_len.fields = { LIST: ['L', L_LIST] };
bw_cond.inputs = { OPERAND1: ptr(bw_len.id), OPERAND2: num(5) };
const bw_add2 = blk('data_addtolist'); bw_add2.inputs = { ITEM: str('x') }; bw_add2.fields = { LIST: ['L', L_LIST] };
// call Wgamma
const bw_callC = blk('procedures_call');
bw_callC.mutation = { tagName: 'mutation', children: [], proccode: 'Wgamma', argumentids: JSON.stringify([]), warp: 'false' };

bw_add.next = bw_ru.id;
bw_ru.inputs.CONDITION = ptr(bw_cond.id); bw_ru.inputs.SUBSTACK = ptr(bw_add2.id); bw_ru.next = bw_callC.id;
defB.next = bw_add.id;
bw_add.parent = defB.id;

// === Walpha %n ===
// set G to arg0
const aw_set = blk('data_setvariableto'); aw_set.fields = { VARIABLE: ['G', G_VAR] };
const aw_arg0ref = blk('argument_reporter_string_number'); aw_arg0ref.shadow = true; aw_arg0ref.fields = { VALUE: ['arg0'] };
aw_set.inputs = { VALUE: ptr(aw_arg0ref.id) };
// repeat 3 { change G by 1 }
const aw_repeat = blk('control_repeat'); aw_repeat.inputs = { TIMES: num(3) };
const aw_change = blk('data_changevariableby'); aw_change.inputs = { VALUE: num(1) }; aw_change.fields = { VARIABLE: ['G', G_VAR] };
// if <arg0 > 0> then set G to 0 else set G to 1
const aw_if = blk('control_if_else');
const aw_c = blk('operator_gt');
const aw_arg0ref2 = blk('argument_reporter_string_number'); aw_arg0ref2.shadow = true; aw_arg0ref2.fields = { VALUE: ['arg0'] };
aw_c.inputs = { OPERAND1: ptr(aw_arg0ref2.id), OPERAND2: num(0) };
const aw_set0 = blk('data_setvariableto'); aw_set0.inputs = { VALUE: num(0) }; aw_set0.fields = { VARIABLE: ['G', G_VAR] };
const aw_set1 = blk('data_setvariableto'); aw_set1.inputs = { VALUE: num(1) }; aw_set1.fields = { VARIABLE: ['G', G_VAR] };
// forever { if <mouse down?> then change G by 1 }
const aw_forever = blk('control_forever');
const aw_if2 = blk('control_if');
const aw_mousedown = blk('sensing_mousedown');
const aw_change2 = blk('data_changevariableby'); aw_change2.inputs = { VALUE: num(1) }; aw_change2.fields = { VARIABLE: ['G', G_VAR] };
// call Wbeta("hi")
const aw_callB = blk('procedures_call');
aw_callB.mutation = { tagName: 'mutation', children: [], proccode: 'Wbeta %s', argumentids: JSON.stringify(['b0']), warp: 'false' };
aw_callB.inputs = { b0: str('hi') };

aw_set.next = aw_repeat.id;
aw_repeat.inputs.SUBSTACK = ptr(aw_change.id); aw_repeat.next = aw_if.id;
aw_if.inputs.CONDITION = ptr(aw_c.id); aw_if.inputs.SUBSTACK = ptr(aw_set0.id); aw_if.inputs.SUBSTACK2 = ptr(aw_set1.id); aw_if.next = aw_forever.id;
aw_forever.inputs.SUBSTACK = ptr(aw_if2.id); aw_forever.next = aw_callB.id;
aw_if2.inputs.CONDITION = ptr(aw_mousedown.id); aw_if2.inputs.SUBSTACK = ptr(aw_change2.id);

const defA = blk('procedures_definition'); defA.topLevel = true;
const protoA = blk('procedures_prototype'); protoA.shadow = true; protoA.parent = defA.id;
const aw_argId = 'a0';
const argA0 = blk('argument_reporter_string_number'); argA0.shadow = true; argA0.fields = { VALUE: ['arg0'] };
protoA.inputs = { [aw_argId]: [1, argA0.id] };
argA0.parent = protoA.id;
protoA.mutation = {
    tagName: 'mutation', children: [], proccode: 'Walpha %n', argumentids: JSON.stringify([aw_argId]),
    argumentnames: JSON.stringify(['arg0']), argumentdefaults: JSON.stringify(['']), warp: 'false',
};
defA.inputs = { custom_block: [1, protoA.id] };
defA.next = aw_set.id;
aw_set.parent = defA.id;

// === when green flag clicked: Walpha(5); Wbeta("a"); set G to G ===
const hat = blk('event_whenflagclicked'); hat.topLevel = true;
const hc1 = blk('procedures_call');
hc1.mutation = { tagName: 'mutation', children: [], proccode: 'Walpha %n', argumentids: JSON.stringify(['a0']), warp: 'false' };
hc1.inputs = { a0: num(5) };
const hc2 = blk('procedures_call');
hc2.mutation = { tagName: 'mutation', children: [], proccode: 'Wbeta %s', argumentids: JSON.stringify(['b0']), warp: 'false' };
hc2.inputs = { b0: str('a') };
const hc3 = blk('data_setvariableto'); hc3.fields = { VARIABLE: ['G', G_VAR] };
hc3.inputs = { VALUE: ptr(varRef(G_VAR, 'G')) };
hat.next = hc1.id; hc1.next = hc2.id; hc2.next = hc3.id;
hc1.parent = hat.id; hc2.parent = hat.id; hc3.parent = hat.id;

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------
for (const b of Object.values(blocks)) {
    const o: any = { opcode: b.opcode, next: b.next, parent: b.parent, inputs: b.inputs, fields: b.fields };
    if (b.shadow) o.shadow = true;
    if (b.topLevel) { o.topLevel = true; o.x = b.x; o.y = b.y; }
    if (b.mutation) o.mutation = b.mutation;
    sprite.blocks[b.id] = o;
}

const project: any = {
    targets: [stage, sprite],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.0.0', agent: 'unwarp-test' },
};

const out = path.resolve(process.argv[2] || 'out/test_complex.sb3');
const JSZip = require('@turbowarp/jszip');
const zip = new JSZip();
zip.file('project.json', JSON.stringify(project));
// minimal costume asset so the zip is loadable
zip.file(ASSET + '.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
zip.generateAsync({ type: 'uint8array' }).then((buf: Uint8Array) => {
    fs.writeFileSync(out, buf);
    console.log('wrote', out, 'with', Object.keys(sprite.blocks).length, 'blocks');
});
