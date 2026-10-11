/**
 * Extract a plain (uncompiled) 02Engine Packager HTML -> .sb3.
 *
 * 02Engine embeds the project archive as base85 chunks in `<script data="...">` tags and
 * decodes them in DOM order into a single ArrayBuffer. Same base85 variant as unwarp's
 * unpackager (charset 0x2a..0x7e, with (<> substitution). No compiled-project metadata is
 * present, so the decoded buffer is already a complete .sb3 zip (project.json + assets).
 *
 * Usage: npx tsx tools/_extract_o2engine.ts <input.html> <output.sb3>
 */
import fs from 'fs';
import path from 'path';

console.error('START', process.argv.slice(2));
const [, , input, output] = process.argv;
if (!input || !output) {
    console.error('usage: npx tsx tools/_extract_o2engine.ts <input.html> <output.sb3>');
    process.exit(1);
}

function getBase85DecodeValue(code: number): number {
    if (code === 0x28) code = 0x3c;
    if (code === 0x29) code = 0x3e;
    return code - 0x2a;
}

const html = fs.readFileSync(path.resolve(input), 'utf8');
console.error('read html', html.length);

const chunkRe = /<script\b[^>]*data="([^"]*)"[^>]*>/g;
const chunks: string[] = [];
let m: RegExpExecArray | null;
while ((m = chunkRe.exec(html)) !== null) chunks.push(m[1]);
console.error('found', chunks.length, 'base85 data chunks');

const totalBytes = chunks.reduce((a, c) => a + Math.floor(c.length / 5) * 4, 0);
console.error('decoded size', totalBytes);

const buffer = new ArrayBuffer(totalBytes);
const view = new DataView(buffer);
let offset = 0;
for (const str of chunks) {
    for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
        view.setUint32(j + offset, (
            getBase85DecodeValue(str.charCodeAt(i + 4)) * 85 * 85 * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 3)) * 85 * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 2)) * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 1)) * 85 +
            getBase85DecodeValue(str.charCodeAt(i))
        ), true);
    }
    offset += Math.floor(str.length / 5) * 4;
}

const bytes = new Uint8Array(buffer);
fs.writeFileSync(path.resolve(output), bytes);
console.error('wrote', output, bytes.length);
