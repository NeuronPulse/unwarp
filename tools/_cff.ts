import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');
const VM = require('../02scratch-vm/src/virtual-machine.js');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { deobfuscateFactorySource } = require('../src/deobfuscator/index');
const { decompileScript, IntermediateStack, IntermediateInput } = require('../src/decompiler/index');

function sig(v: any): string {
  if (v instanceof IntermediateStack) return `[${v.blocks.map(b => sig(b)).join(' ')}]`;
  if (v instanceof IntermediateInput) {
    const inner = Object.entries(v.inputs || {}).map(([k, x]) => `${k}=${sig(x)}`).join(' ');
    return `${v.opcode}${inner ? '{' + inner + '}' : ''}`;
  }
  if (Array.isArray(v)) return v.map(x => sig(x)).join(',');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function blockLine(b: any, indent = ''): string[] {
  const out = [`${indent}${b.opcode}${b.yields ? '*' : ''}`];
  for (const [k, v] of Object.entries(b.inputs || {})) {
    if (v instanceof IntermediateStack) {
      out.push(`${indent}  ${k}:`);
      for (const sub of v.blocks) out.push(...blockLine(sub, indent + '    '));
    } else out.push(`${indent}  ${k} = ${sig(v)}`);
  }
  return out;
}
async function main() {
const input = process.argv[2];
const data = fs.readFileSync(path.resolve(input));
const zip = await JSZip.loadAsync(data);
const projectJSON = JSON.parse(await zip.file('project.json').async('string'));
const vm = new VM();
vm.setCompilerOptions({ enabled: true, warpTimer: true });
const compiled = await vm.compileProjectFromJSON(projectJSON, zip);
const mk = (cff: boolean) => ({
  compact: true, controlFlowFlattening: cff, controlFlowFlatteningThreshold: 1,
  selfDefending: false, deadCodeInjection: false, debugProtection: false, disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true, renameGlobals: false,
  simplify: true, splitStrings: true, splitStringsChunkLength: 6, stringArray: true,
  stringArrayEncoding: ['rc4'], stringArrayIndexesType: ['hexadecimal-number'], stringArrayRotate: true,
  stringArrayShuffle: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function',
  stringArrayThreshold: 1, target: 'browser', transformObjectKeys: false, unicodeEscapeSequence: false,
});
const wrap = (s: string) => `(()=>{const __o2_factory_out__=${s.replace(/^\s*(async\s+)?function\s+[^(]+\s*\(/, (m: string, a = '') => `${a}function(`)};return __o2_factory_out__;})()`;
const listIds = new Set<string>();
for (const t of projectJSON.targets || []) for (const k of Object.keys(t.lists || {})) listIds.add(k);
const out: string[] = [];
for (const t of Object.values<any>(compiled.compiledTargets || {})) {
  for (const [v, p] of Object.entries<any>(t.procedures || {})) {
    if (!String(v).includes('Tokenizer')) continue;
    for (const [label, cff] of [['CFF-on', true]] as const) {
      const obf = JavaScriptObfuscator.obfuscate(wrap(p.factorySource), mk(cff)).getObfuscatedCode();
      // find declaration site of the unresolved decoder-call name in the deobfuscated output
      const res = deobfuscateFactorySource(`eval(${JSON.stringify(obf)})`);
      const names = new Set<string>();
      const re = /(_0x[0-9a-fA-F]+)\(-0x[0-9a-fA-F]+,'[^']*'\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(res.source))) names.add(m[1]);
      for (const nm of names) {
        // locate `function <nm>` in the RAW obfuscated source
        const declRe = new RegExp(`function\\\\s+${nm}\\\\b`);
        const inRaw = declRe.test(obf);
        // find its declaration text in raw (up to 200 chars)
        const idx = obf.search(declRe);
        out.push(`\\n### unresolved decoder call: ${nm} | declared in raw: ${inRaw} | idx=${idx}`);
        if (idx >= 0) out.push('RAW DECL: ' + obf.slice(idx, idx + 200));
        const didx = res.source.search(declRe);
        out.push(`| declared in deobf: ${didx >= 0}`);
        if (didx >= 0) out.push('DEOBF DECL: ' + res.source.slice(didx, didx + 200));
      }
      out.push('\\n########## tokenizer ' + label + ' ##########');
      const script = decompileScript(res.source, { variant: v, listIds });
      for (const b of script.stack?.blocks ?? []) out.push(...blockLine(b));
    }
  }
}
fs.writeFileSync('/tmp/ir.txt', out.join('\n'));
console.log('written /tmp/ir.txt');
}
main().catch(e => { console.error(e); process.exit(1); });
