/**
 * CLI: raw .sb3 + 02scratch-vm compiled JSON -> .sb3
 *
 * Reuses the exact decompile+serialize pipeline that `unpackageHTML` uses, but takes the
 * compiled data straight from `tools/compile.mjs` instead of an 02packager HTML. This lets us
 * round-trip any .sb3 (package it with 02packager conceptually via compileProjectFromJSON, then
 * rebuild the blocks) without going through the HTML bootstrap.
 *
 * Usage: npx tsx tools/unpack-from-data.ts <input.sb3> <output.sb3> [--warnings]
 *
 * It writes <input>.compiled.json next to the input, then rebuilds the blocks over the original
 * project.json (keeping all costumes/sounds/variables) and re-zips.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { rebuildProjectJSON } from '../src/unpackager/index';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');
const VM = require('../02scratch-vm/src/virtual-machine.js');

async function main() {
    const [, , input, output, ...flags] = process.argv;
    if (!input || !output) {
        console.error('usage: npx tsx tools/unpack-from-data.ts <input.sb3> <output.sb3> [--warnings]');
        process.exit(1);
    }

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
            if (typeof vm.extensionManager[name] === 'function') {
                vm.extensionManager[name] = () => Promise.resolve();
            }
        }
    }
    const compiled = await vm.compileProjectFromJSON(projectJSON, zip);

    // Strip blocks (mirrors what 02packager embeds) — they are rebuilt from compiled data.
    for (const t of projectJSON.targets) t.blocks = {};

    const res = rebuildProjectJSON(projectJSON, compiled);
    if (flags.includes('--warnings') || res.warnings.length) {
        const counts = new Map<string, number>();
        for (const w of res.warnings) {
            const key = w.replace(/\[[^\]]*\]/g, '[]').replace(/".*?"/g, '"…"');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
            console.log(`  ${String(n).padStart(4)}  ${k}`);
        }
    }

    zip.file('project.json', JSON.stringify(projectJSON));
    const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    fs.writeFileSync(path.resolve(output), buf);
    let blocks = 0, top = 0, defs = 0;
    for (const t of projectJSON.targets) for (const b of Object.values<any>(t.blocks || {})) {
        blocks++; if (b.topLevel) top++; if (b.opcode === 'procedures_definition') defs++;
    }
    console.log(`wrote ${output} targets=${projectJSON.targets.length} blocks=${blocks} topLevel=${top} procDefs=${defs} warnings=${res.warnings.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
