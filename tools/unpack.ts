/**
 * CLI: 02packager compiled HTML / 02Engine plain HTML -> .sb3
 *
 * Usage: npx tsx tools/unpack.ts <input.html> <output.sb3> [--warnings]
 */
import fs from 'fs';
import path from 'path';
import { unpackageHTML } from '../src/unpackager/index';

const [, , input, output, ...flags] = process.argv;
if (!input || !output) {
    console.error('usage: npx tsx tools/unpack.ts <input.html> <output.sb3>');
    process.exit(1);
}

async function main() {
    const html = fs.readFileSync(path.resolve(input), 'utf8');
    const { sb3, warnings, mode } = await unpackageHTML(html);
    fs.writeFileSync(path.resolve(output), sb3);
    console.log(`wrote ${output} (${sb3.length} bytes)`);
    if (mode === 'plain') {
        console.log('note: plain (uncompiled) 02Engine HTML — project archive extracted as-is, no decompilation needed');
    }
    if (flags.includes('--warnings') || warnings.length) {
        console.log(`\nwarnings (${warnings.length}):`);
        const counts = new Map<string, number>();
        for (const w of warnings) {
            const key = w.replace(/\[[^\]]*\]/g, '[]').replace(/".*?"/g, '"…"');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
            console.log(`  ${String(n).padStart(4)}  ${k}`);
        }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
