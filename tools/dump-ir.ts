/**
 * Dev harness: dump what unwarp's decompiler recovers from each compiled factory source,
 * so a mis-recognised block can be spotted by comparing IR opcodes against the JS.
 *
 * Usage: npx tsx tools/dump-ir.ts <compiled.json> [targetIndex] [--src]
 */
import fs from 'fs';
import { deobfuscateFactorySource } from '../src/deobfuscator/index';
import { decompileScript, IntermediateStack, IntermediateInput, IntermediateStackBlock } from '../src/decompiler/index';

const [, , compiledPath, targetArg, ...flags] = process.argv;
const compiled = JSON.parse(fs.readFileSync(compiledPath!, 'utf8'));
const showSrc = flags.includes('--src');
const onlyTarget = targetArg && !targetArg.startsWith('-') ? Number(targetArg) : null;

// Lists are declared on one target but referenced from any script; ids are global.
const listIds = new Set<string>();
for (const t of compiled.targets || []) for (const k of Object.keys(t.lists || {})) listIds.add(k);

function sig(v: any, depth = 0): string {
    if (v instanceof IntermediateStack) return `[${v.blocks.map(b => sig(b, depth)).join(' ')}]`;
    if (v instanceof IntermediateInput) {
        const inner = Object.entries(v.inputs || {})
            .map(([k, x]) => `${k}=${sig(x, depth + 1)}`).join(' ');
        return `${v.opcode}${inner ? '{' + inner + '}' : ''}`;
    }
    if (Array.isArray(v)) return v.map(x => sig(x, depth)).join(',');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function blockLine(b: IntermediateStackBlock, indent = ''): string[] {
    const out = [`${indent}${b.opcode}${b.yields ? '*' : ''}`];
    for (const [k, v] of Object.entries(b.inputs || {})) {
        if (v instanceof IntermediateStack) {
            out.push(`${indent}  ${k}:`);
            for (const sub of v.blocks) out.push(...blockLine(sub, indent + '    '));
        } else {
            out.push(`${indent}  ${k} = ${sig(v)}`);
        }
    }
    return out;
}

for (const [ti, t] of Object.entries<any>(compiled.compiledTargets || {})) {
    if (onlyTarget !== null && Number(ti) !== onlyTarget) continue;
    console.log(`\n########## target ${ti} ${t.name ?? ''} ##########`);
    for (const [id, s] of Object.entries<any>(t.scripts || {})) {
        console.log(`\n--- script ${JSON.stringify(id)} executableHat=${s.executableHat}`);
        if (showSrc) console.log(s.factorySource);
        try {
            const res = deobfuscateFactorySource(s.factorySource || '');
            const script = decompileScript(res.source, { listIds });
            for (const b of script.stack?.blocks ?? []) console.log(blockLine(b).join('\n'));
        } catch (e: any) { console.log('  ERROR: ' + e.message); }
    }
    for (const [variant, p] of Object.entries<any>(t.procedures || {})) {
        console.log(`\n--- procedure ${JSON.stringify(variant)}`);
        if (showSrc) console.log(p.factorySource);
        try {
            const res = deobfuscateFactorySource(p.factorySource || '');
            const script = decompileScript(res.source, { variant, listIds });
            for (const b of script.stack?.blocks ?? []) console.log(blockLine(b).join('\n'));
        } catch (e: any) { console.log('  ERROR: ' + e.message); }
    }
}
