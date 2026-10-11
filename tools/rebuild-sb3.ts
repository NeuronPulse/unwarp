/**
 * sb3 -> (02scratch-vm compile) -> (unwarp rebuild) -> sb3
 *
 * Mirrors what 02packager does to a project (compile + strip blocks) and then runs unwarp's
 * unpackager over it, so the result can be opened in an editor and diffed against the input.
 *
 * Usage: npx tsx tools/rebuild-sb3.ts <input.sb3> <output.sb3>
 */
import fs from 'fs';
import { createRequire } from 'module';
import { rebuildProjectJSON } from '../src/unpackager/index';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');

const [, , input, output] = process.argv;
if (!input || !output) { console.error('usage: rebuild-sb3.ts <input.sb3> <output.sb3>'); process.exit(1); }

async function main() {
    const zip = await JSZip.loadAsync(fs.readFileSync(input));
    const compiled = JSON.parse(fs.readFileSync(input.replace(/\.sb3$/i, '') + '.compiled.json', 'utf8'));

    // Stand in for the asset archive 02packager ships: keep every file, replace project.json
    // with the stripped snapshot (blocks emptied) exactly as cloneCompiledTargetSnapshot does.
    const projectJSON = compiled.targets
        ? { ...JSON.parse(await zip.file('project.json').async('string')), targets: compiled.targets }
        : JSON.parse(await zip.file('project.json').async('string'));

    const { warnings, rebuiltTargets } = rebuildProjectJSON(projectJSON, compiled);
    console.log(`rebuilt ${rebuiltTargets} target(s)`);
    if (warnings.length) {
        console.log(`warnings (${warnings.length}):`);
        for (const w of warnings.slice(0, 20)) console.log('  ! ' + w);
    }

    zip.file('project.json', JSON.stringify(projectJSON));
    const sb3 = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    fs.writeFileSync(output, sb3);
    console.log(`wrote ${output} (${sb3.length} bytes)`);
}
main().catch(e => { console.error(e); process.exit(1); });
