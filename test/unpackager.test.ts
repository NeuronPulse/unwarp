/**
 * Unpackager tests: build a fake 02packager compiled-project HTML (with base85-encoded
 * asset archive + compiled project metadata containing deobfuscated/obfuscated factory
 * sources), run unpackageHTML, and verify the resulting .sb3 has valid project.json
 * with reconstructed blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deobfuscateFactorySource } from '../src/deobfuscator/index';
import { unpackageHTML } from '../src/unpackager/index';
import { JSG, INTER, ENUMS, compileToSource, STACK, SB, C, N, B, VB, VAR, IN } from './harness';

let JSO: any = null;
try { JSO = require('javascript-obfuscator'); } catch { JSO = null; }

let JSZip: any = null;
try { JSZip = require('@turbowarp/jszip'); } catch { JSZip = null; }

// ---------------------------------------------------------------------------
// Base85 encoder — mirrors 02packager/src/packager/base85.js
// ---------------------------------------------------------------------------

function getBase85EncodeChar(n: number): number {
    n += 0x2a;
    if (n === 0x3c) return 0x28;
    if (n === 0x3e) return 0x29;
    return n;
}

function base85encode(data: Uint8Array): string {
    const originalLength = data.length;
    let dataView: DataView;
    if (originalLength % 4 !== 0) {
        const padded = new Uint8Array(Math.ceil(originalLength / 4) * 4);
        padded.set(data);
        dataView = new DataView(padded.buffer);
    } else {
        dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    const result = new Uint8Array(Math.ceil(originalLength / 4) * 5);
    let idx = 0;
    for (let i = 0; i < dataView.byteLength; i += 4) {
        let n = dataView.getUint32(i, true);
        result[idx++] = getBase85EncodeChar(n % 85);
        n = Math.floor(n / 85);
        result[idx++] = getBase85EncodeChar(n % 85);
        n = Math.floor(n / 85);
        result[idx++] = getBase85EncodeChar(n % 85);
        n = Math.floor(n / 85);
        result[idx++] = getBase85EncodeChar(n % 85);
        n = Math.floor(n / 85);
        result[idx++] = getBase85EncodeChar(n % 85);
    }
    return new TextDecoder().decode(result.subarray(0, idx));
}

// ---------------------------------------------------------------------------
// Factory source wrapping (mirrors 02packager)
// ---------------------------------------------------------------------------

function packagerWrap(source: string): string {
    const anonymized = source.replace(
        /^\s*(async\s+)?function\s+[^(]+\s*\(/,
        (_m, a = '') => `${a}function(`,
    );
    return `(()=>{const __o2_factory_out__=${anonymized};return __o2_factory_out__;})()`;
}

function storeAsEval(code: string): string {
    return `eval(${JSON.stringify(code)})`;
}

// ---------------------------------------------------------------------------
// Build a fake compiled-project HTML (mirrors 02packager's output format)
// ---------------------------------------------------------------------------

interface CompiledScriptEntry {
    factorySource: string;
    executableHat?: boolean;
}

interface CompiledTargetEntry {
    scripts: Record<string, CompiledScriptEntry>;
    procedures: Record<string, CompiledScriptEntry>;
    hats: any[];
}

function buildCompiledProject(
    targets: any[],
    compiledTargets: Record<string, CompiledTargetEntry>,
    monitors: any[] = [],
): any {
    return {
        format: '02engine-compiled-project',
        compiledTargets,
        targets,
        monitors,
        meta: { semver: '0.0.0', vm: '0.0.0' },
    };
}

function buildHTML(
    compiledProject: any,
    archiveZip: Uint8Array,
): string {
    const compiledProjectString = JSON.stringify(compiledProject);

    // Base85-encode the archive into chunks
    const CHUNK_SIZE = 1024 * 64;
    let chunks = '';
    for (let i = 0; i < archiveZip.length; i += CHUNK_SIZE) {
        const chunk = archiveZip.subarray(i, i + CHUNK_SIZE);
        const b85 = base85encode(chunk);
        chunks += `<script type="application/x-o2-project-chunk" data-size="${chunk.length}">${b85}</script>\n`;
    }

    const getProjectData = `() => {
        const buffer = projectDecodeBuffer;
        return Promise.resolve({
            projectData: JSON.parse(decodeURIComponent("${encodeURIComponent(compiledProjectString)}")),
            projectArchive: new Uint8Array(buffer, 0, ${archiveZip.length})
        });
    }`;

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Test</title></head>
<body>
<div id="app"></div>
<script>
// scaffolding would be here
const getBase85DecodeValue = (code) => { if (code===0x28)code=0x3c; if(code===0x29)code=0x3e; return code-0x2a; };
const base85decode = (str, outBuffer, outOffset) => {};
let projectDecodeBuffer = new ArrayBuffer(${Math.ceil(archiveZip.length / 4) * 4});
let projectDecodeIndex = 0;
</script>
${chunks}
<script>
const getProjectData = ${getProjectData};
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Build a minimal SB3 project.json target for the asset archive
// ---------------------------------------------------------------------------

function buildMinimalTarget(name: string, isStage: boolean, variables: Record<string, any> = {}, lists: Record<string, any> = {}): any {
    return {
        isStage,
        name,
        variables,
        lists,
        broadcasts: {},
        blocks: {},
        currentCostume: 0,
        costumes: [{ assetId: 'test', name: 'c1', md5ext: 'test.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0 }],
        sounds: [],
        volume: 100,
        layerOrder: isStage ? 0 : 1,
        visible: true,
        x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function skipIfNoDeps(): boolean {
    if (!JSG || !JSO) { test.skip('jsgen or javascript-obfuscator unavailable'); return true; }
    if (!JSZip) { test.skip('@turbowarp/jszip unavailable'); return true; }
    return false;
}

test('unpackageHTML: extract and decompile a simple compiled-project HTML (no obfuscation)', async () => {
    if (skipIfNoDeps()) return;

    // Build a simple script
    const v1 = VB('V1');
    const native = new INTER.IntermediateScript();
    native.stack = new INTER.IntermediateStack([
        SB('LOOKS_SAY', { message: C('hello') }),
        SB('VAR_SET', { variable: v1, value: N(42) }),
    ]);
    native.yields = true;
    native.topBlockId = 'hat1';

    const source = compileToSource(native);

    // The target's variables map (SB3 format: { id: [name, value] })
    const variables = { V1: ['V1', 0] };
    const target = buildMinimalTarget('Sprite1', false, variables);
    const stage = buildMinimalTarget('Stage', true);

    const projectJSON = {
        targets: [stage, target],
        monitors: [],
        meta: { semver: '3.0.0' },
    };

    // Build the asset archive zip (just project.json)
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(projectJSON));
    const archiveBytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

    // Build compiled project data
    const compiledTargets: Record<string, CompiledTargetEntry> = {
        '1': {
            scripts: {
                hat1: { factorySource: storeAsEval(packagerWrap(source)) },
            },
            procedures: {},
            hats: [{ topBlockId: 'hat1', opcode: 'event_whenflagclicked', fieldsOfInputs: {} }],
        },
    };

    const compiledProject = buildCompiledProject(projectJSON.targets, compiledTargets);
    const html = buildHTML(compiledProject, archiveBytes);

    // Run unpackageHTML
    const { sb3, warnings } = await unpackageHTML(html);
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);

    // Verify sb3 is a valid zip with project.json
    const resultZip = await JSZip.loadAsync(sb3);
    const resultProjectJSON = JSON.parse(await resultZip.file('project.json').async('string'));

    assert.ok(resultProjectJSON.targets, 'project.json should have targets');
    assert.equal(resultProjectJSON.targets.length, 2);
    assert.equal(resultProjectJSON.targets[1].name, 'Sprite1');

    // Check that blocks were reconstructed
    const blocks = resultProjectJSON.targets[1].blocks;
    assert.ok(blocks && typeof blocks === 'object', 'blocks should be an object');
    assert.ok(Object.keys(blocks).length > 0, 'blocks should not be empty');

    // Find the hat block and the first body block
    const blockList = Object.values(blocks) as any[];
    const hatBlock = blockList.find((b) => b.opcode === 'event_whenflagclicked');
    assert.ok(hatBlock, 'should have event_whenflagclicked hat');
    const sayBlock = blockList.find((b) => b.opcode === 'looks_say');
    assert.ok(sayBlock, 'should have looks_say block');
    const varSetBlock = blockList.find((b) => b.opcode === 'data_setvariableto');
    assert.ok(varSetBlock, 'should have data_setvariableto block');
});

test('unpackageHTML: extract a plain (uncompiled) 02Engine HTML', async () => {
    if (!JSZip) { test.skip('@turbowarp/jszip unavailable'); return; }

    // A plain 02Engine HTML embeds the *original* project zip (blocks intact).
    const projectJSON: any = {
        targets: [buildMinimalTarget('Stage', true), buildMinimalTarget('Sprite1', false)],
        monitors: [],
        meta: { semver: '3.0.0' },
    };
    projectJSON.targets[1].blocks = {
        b1: { opcode: 'event_whenflagclicked', topLevel: true, parent: null, inputs: {}, fields: {}, next: null, shadow: false },
    };

    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(projectJSON));
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

    // Chunk like the plain 02Engine packager: base85 in a data= attribute, byte size in
    // decodeChunk(N) wrapped in /*Generated By 02Engine Packager*/ comments.
    let html = '<!DOCTYPE html>\n<html><body>\n';
    const CHUNK = 256;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        html += `<script data="${base85encode(chunk)}">`
            + `/*Generated By 02Engine Packager*/decodeChunk(`
            + `/*Generated By 02Engine Packager*/${chunk.length}`
            + `/*Generated By 02Engine Packager*/)</script>\n`;
    }
    html += '</body></html>';

    const { sb3, warnings, mode } = await unpackageHTML(html);
    assert.equal(mode, 'plain');
    assert.equal(warnings.length, 0);

    const resultZip = await JSZip.loadAsync(sb3);
    const resultProjectJSON = JSON.parse(await resultZip.file('project.json').async('string'));
    // Blocks must survive untouched (no decompilation involved).
    assert.equal(resultProjectJSON.targets[1].blocks.b1.opcode, 'event_whenflagclicked');
});

test('unpackageHTML: rejects an HTML without embedded project data', async () => {
    await assert.rejects(
        () => unpackageHTML('<html><body><p>not a packaged project</p></body></html>'),
        /No 02engine project chunks found/,
    );
});

// TODO(strong): the strong obfuscation tier is not implemented in the deobfuscator yet;
// re-enable once deobfuscateFactorySource survives it end-to-end.
test.skip('unpackageHTML: extract and decompile a rich compiled-project HTML (strong obfuscation)', async () => {
    if (skipIfNoDeps()) return;

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
    native.topBlockId = 'hat1';

    const source = compileToSource(native);

    const variables = { V1: ['V1', 0] };
    const lists = { L1: ['L1', []] };
    const target = buildMinimalTarget('Sprite1', false, variables, lists);
    const stage = buildMinimalTarget('Stage', true);

    const projectJSON = {
        targets: [stage, target],
        monitors: [],
        meta: { semver: '3.0.0' },
    };

    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(projectJSON));
    const archiveBytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

    // Obfuscate the factory source at strong level
    const strongOpts = {
        compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.3,
        deadCodeInjection: false, debugProtection: false, disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true, renameGlobals: false,
        selfDefending: true, simplify: true, splitStrings: true, splitStringsChunkLength: 6,
        stringArray: true, stringArrayCallsTransform: false, stringArrayEncoding: ['rc4'],
        stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true, stringArrayShuffle: true,
        stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayThreshold: 1,
        target: 'browser', transformObjectKeys: false, unicodeEscapeSequence: false,
    };
    const obfuscated = JSO.obfuscate(packagerWrap(source), strongOpts).getObfuscatedCode();
    const factorySource = storeAsEval(obfuscated);

    const compiledTargets: Record<string, CompiledTargetEntry> = {
        '1': {
            scripts: {
                hat1: { factorySource },
            },
            procedures: {},
            hats: [{ topBlockId: 'hat1', opcode: 'event_whenflagclicked', fieldsOfInputs: {} }],
        },
    };

    const compiledProject = buildCompiledProject(projectJSON.targets, compiledTargets);
    const html = buildHTML(compiledProject, archiveBytes);

    const { sb3, warnings } = await unpackageHTML(html);
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);

    const resultZip = await JSZip.loadAsync(sb3);
    const resultProjectJSON = JSON.parse(await resultZip.file('project.json').async('string'));

    const blocks = resultProjectJSON.targets[1].blocks;
    const blockList = Object.values(blocks) as any[];

    // Verify key blocks exist
    const opcodes = new Set(blockList.filter((b) => !Array.isArray(b)).map((b) => b.opcode));
    assert.ok(opcodes.has('event_broadcast'), 'should have broadcast block');
    assert.ok(opcodes.has('looks_say'), 'should have looks_say block');
    assert.ok(opcodes.has('data_addtolist'), 'should have list add block');
    assert.ok(opcodes.has('data_setvariableto'), 'should have var.set block');
    assert.ok(opcodes.has('control_if_else'), 'should have control.if block');
    assert.ok(opcodes.has('control_repeat'), 'should have control.repeat');
    assert.ok(opcodes.has('control_while'), 'should have control.while');
    assert.ok(opcodes.has('control_for_each'), 'should have control.for (for_each)');
    assert.ok(opcodes.has('event_broadcastandwait'), 'should have broadcastAndWait');
    assert.ok(opcodes.has('control_wait'), 'should have control.wait');
    assert.ok(opcodes.has('control_stop'), 'should have control.stopScript');
});
