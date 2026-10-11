/**
 * Dev harness: sb3 -> (02scratch-vm compileProjectFromJSON) -> compiledProject JSON.
 *
 * Mirrors what 02packager does internally (src/packager/packager.js getCompiledProjectData),
 * so we can exercise unwarp's decompile+serialize path without building the whole packager.
 *
 * Usage: node tools/compile.mjs <input.sb3> [output.json]
 */
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');
const VM = require('../02scratch-vm/src/virtual-machine.js');

const input = process.argv[2];
const output = process.argv[3] || input.replace(/\.sb3$/i, '') + '.compiled.json';

const data = fs.readFileSync(input);
const zip = await JSZip.loadAsync(data);
const projectFile = zip.file('project.json');
if (!projectFile) throw new Error('project.json not found in ' + input);
const projectJSON = JSON.parse(await projectFile.async('string'));

const vm = new VM();
if (typeof vm.attachStorage === 'function') {
    try {
        const ScratchStorage = require('../02scratch-vm/src/storage/scratch-storage.js');
        vm.attachStorage(new ScratchStorage());
    } catch (e) {
        console.error('warn: storage attach failed:', e.message);
    }
}
if (vm.securityManager) {
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    // Offline compile: skip fetching/executing unsandboxed extension scripts. The extension ids
    // still land in compiledProject.extensions, and any block they provide falls back to the
    // compatibility layer -- which is exactly what unwarp has to handle for custom JS blocks.
    vm.securityManager.canLoadExtensionFromProject = () => !process.env.NO_EXT;
}
vm.setCompilerOptions({ enabled: true, warpTimer: true });

if (process.env.NO_EXT) {
    // Neutralise remote/unsandboxed extension loading entirely: no fetch, no script execution.
    for (const name of ['loadExtensionURL', 'loadExtensionURLSync', 'loadExtensionIdSync']) {
        if (typeof vm.extensionManager[name] === 'function') {
            vm.extensionManager[name] = () => Promise.resolve();
        }
    }
}

const compiled = await vm.compileProjectFromJSON(projectJSON, zip);

fs.writeFileSync(output, JSON.stringify(compiled));
console.log('wrote', output, fs.statSync(output).size, 'bytes');
let scripts = 0, procedures = 0, hats = 0;
for (const t of Object.values(compiled.compiledTargets || {})) {
    scripts += Object.keys(t.scripts || {}).length;
    procedures += Object.keys(t.procedures || {}).length;
    hats += (t.hats || []).length;
}
console.log('targets=%d scripts=%d procedures=%d hats=%d',
    Object.keys(compiled.compiledTargets || {}).length, scripts, procedures, hats);
