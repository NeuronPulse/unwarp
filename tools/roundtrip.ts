/**
 * Dev harness: faithful re-implementation of 02packager's precompilation
 * (vm.compileProjectFromJSON + javascript-obfuscator at one of the three levels
 * used by 02packager: light / balanced / strong), followed by unwarp's
 * decompile + serialize pipeline, then re-zip into a .sb3.
 *
 * This exercises the exact obfuscation 02packager applies so we can verify unwarp
 * reconstructs every block at every obfuscation level.
 *
 * Usage: npx tsx tools/roundtrip.ts <input.sb3> <level> [output.sb3]
 *   env: NO_EXT=1  -> skip loading external (URL) extensions during compile
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { rebuildProjectJSON } from '../src/unpackager/index';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');
const VM = require('../02scratch-vm/src/virtual-machine.js');
const JavaScriptObfuscator = require('javascript-obfuscator');

// --- verbatim copy of 02packager/src/packager/packager.js obfuscation options ---
const getCompiledProjectObfuscationOptions = (level: string) => {
    switch (level) {
        case 'light': return {
            compact: true, controlFlowFlattening: false, deadCodeInjection: false,
            debugProtection: false, disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal', numbersToExpressions: false,
            renameGlobals: false, selfDefending: false, simplify: true,
            splitStrings: false, stringArray: true, stringArrayCallsTransform: false,
            stringArrayEncoding: [], stringArrayIndexesType: ['hexadecimal-number'],
            stringArrayRotate: true, stringArrayShuffle: true,
            stringArrayWrappersCount: 1, stringArrayWrappersType: 'function',
            stringArrayThreshold: 0.75, target: 'browser',
            transformObjectKeys: false, unicodeEscapeSequence: false,
        };
        case 'none': return null; // 不混淆，仅编译
        case 'strong': return {
            compact: true, controlFlowFlattening: process.env.NO_CFF ? false : true, controlFlowFlatteningThreshold: 0.3,
            deadCodeInjection: false, debugProtection: false, disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true,
            renameGlobals: false, selfDefending: !process.env.NO_SELFDEF, simplify: true,
            splitStrings: true, splitStringsChunkLength: 6, stringArray: true,
            stringArrayCallsTransform: false, stringArrayEncoding: ['rc4'],
            stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true,
            stringArrayShuffle: true, stringArrayWrappersCount: 2,
            stringArrayWrappersType: 'function', stringArrayThreshold: 1, target: 'browser',
            transformObjectKeys: false, unicodeEscapeSequence: false,
        };
        case 'balanced':
        default: return {
            compact: true, controlFlowFlattening: false, deadCodeInjection: false,
            debugProtection: false, disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true,
            renameGlobals: false, selfDefending: false, simplify: true,
            splitStrings: true, splitStringsChunkLength: 8, stringArray: true,
            stringArrayCallsTransform: false, stringArrayEncoding: ['base64'],
            stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true,
            stringArrayShuffle: true, stringArrayWrappersCount: 1,
            stringArrayWrappersType: 'function', stringArrayThreshold: 1, target: 'browser',
            transformObjectKeys: false, unicodeEscapeSequence: false,
        };
    }
};

// env-driven overrides for diagnosing which obfuscation transform breaks a project
function applyOverrides(o: any) {
    if (!o) return o;
    if (process.env.NO_SPLITSTR) o.splitStrings = false;
    if (process.env.NO_NUMLIT) o.numbersToExpressions = false;
    if (process.env.NO_STRARR) { o.stringArray = false; o.stringArrayEncoding = []; }
    if (process.env.NO_SIMPLIFY) o.simplify = false;
    return o;
}
const OBFUSCATED_FACTORY_RESULT_NAME = '__o2_factory_out__';
const makeAnonymous = (s: string) => s.replace(
    /^\s*(async\s+)?function\s+[^(]+\s*\(/,
    (m: string, a = '') => `${a}function(`,
);
const wrap = (s: string) => `(()=>{const ${OBFUSCATED_FACTORY_RESULT_NAME}=${makeAnonymous(s)};return ${OBFUSCATED_FACTORY_RESULT_NAME};})()`;
const stringify = (s: string) => `eval(${JSON.stringify(s)})`;

async function main() {
    const [, , input, level = 'balanced', output] = process.argv;
    if (!input) { console.error('usage: roundtrip.ts <input.sb3> <level> [out.sb3]'); process.exit(1); }
    if (!['none', 'light', 'balanced', 'strong'].includes(level)) { console.error('level must be none|light|balanced|strong'); process.exit(1); }

    const data = fs.readFileSync(path.resolve(input));
    const zip = await JSZip.loadAsync(data);
    const projectFile = zip.file('project.json');
    if (!projectFile) throw new Error('project.json not found in ' + input);
    const projectJSON = JSON.parse(await projectFile.async('string'));

    const vm = new VM();
    if (vm.securityManager) {
        vm.securityManager.getSandboxMode = () => 'unsandboxed';
        vm.securityManager.canLoadExtensionFromProject = () => !process.env.NO_EXT;
    }
    vm.setCompilerOptions({ enabled: true, warpTimer: true });
    if (process.env.NO_EXT) {
        for (const name of ['loadExtensionURL', 'loadExtensionURLSync', 'loadExtensionIdSync']) {
            if (typeof vm.extensionManager?.[name] === 'function') {
                vm.extensionManager[name] = () => Promise.resolve();
            }
        }
    }
    const compiled = await vm.compileProjectFromJSON(projectJSON, zip);

    // obfuscate each factory source at the chosen level (mirrors 02packager.obfuscateCompiledProject)
    const options = applyOverrides(getCompiledProjectObfuscationOptions(level));
    if (options) {
        const work: any[] = [];
        for (const t of Object.values<any>(compiled.compiledTargets || {})) {
            for (const s of Object.values<any>(t.scripts || {})) if (s.factorySource) work.push(s);
            for (const p of Object.values<any>(t.procedures || {})) if (p.factorySource) work.push(p);
        }
        for (const item of work) {
            const obfuscated = JavaScriptObfuscator.obfuscate(wrap(item.factorySource), options);
            item.factorySource = stringify(obfuscated.getObfuscatedCode());
        }
    }

    for (const t of projectJSON.targets) t.blocks = {};
    const res = rebuildProjectJSON(projectJSON, compiled);
    if (res.warnings.length) {
        const counts = new Map<string, number>();
        for (const w of res.warnings) {
            const key = w.replace(/\[[^\]]*\]/g, '[]').replace(/".*?"/g, '"…"');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        console.log(`  warnings (${res.warnings.length}):`);
        for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
            console.log(`    ${String(n).padStart(4)}  ${k}`);
        }
    }
    zip.file('project.json', JSON.stringify(projectJSON));
    const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const out = output || input.replace(/\.sb3$/i, '') + `.unwarp.${level}.sb3`;
    fs.writeFileSync(path.resolve(out), buf);
    let blocks = 0, top = 0, defs = 0;
    for (const t of projectJSON.targets) for (const b of Object.values<any>(t.blocks || {})) {
        blocks++; if (b.topLevel) top++; if (b.opcode === 'procedures_definition') defs++;
    }
    console.log(`[${level}] ${path.basename(input)} -> ${path.basename(out)} targets=${projectJSON.targets.length} blocks=${blocks} top=${top} procDefs=${defs} warnings=${res.warnings.length}`);
}

main().catch(e => { console.error('FAILED:', e?.message || e); process.exit(1); });
