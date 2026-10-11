/**
 * Pull the embedded compiled-project JSON out of an 02packager HTML.
 * Usage: npx tsx tools/extract-compiled.ts <input.html> [out.json]
 */
import fs from 'fs';

const [, , input, out] = process.argv;
if (!input) { console.error('usage: extract-compiled.ts <input.html> [out.json]'); process.exit(1); }

const html = fs.readFileSync(input, 'utf8');
const re = /JSON\.parse\(\s*decodeURIComponent\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*\)/g;
let m: RegExpExecArray | null;
let last: string | null = null;
while ((m = re.exec(html)) !== null) last = m[1];
if (!last) throw new Error('compiled-project data not found');
const decoded = decodeURIComponent(last);
if (out) fs.writeFileSync(out, decoded);
const c = JSON.parse(decoded);
console.log('keys:', Object.keys(c).join(', '));
console.log('format:', c.format, 'version:', c.version);
console.log('extensions:', JSON.stringify(c.extensions));
console.log('extensionURLs:', Object.keys(c.extensionURLs || {}).join(', '));
let scripts = 0, procs = 0, hats = 0, custom = 0;
for (const [k, t] of Object.entries<any>(c.compiledTargets || {})) {
    const s = Object.keys(t.scripts || {}).length;
    const p = Object.keys(t.procedures || {}).length;
    scripts += s; procs += p; hats += (t.hats || []).length;
    let tc = 0;
    for (const v of [...Object.values<any>(t.scripts || {}), ...Object.values<any>(t.procedures || {})]) {
        if (typeof v.factorySource === 'string' && v.factorySource.includes('varbelong')) tc++;
    }
    custom += tc;
    console.log(`  target ${k} ${t.name}: scripts=${s} procedures=${p} hats=${(t.hats || []).length} customCode=${tc}`);
}
console.log(`TOTAL scripts=${scripts} procedures=${procs} hats=${hats} customCode=${custom}`);
