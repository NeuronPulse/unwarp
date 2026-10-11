/**
 * Diagnose which procedure-definition script copies the unpackager fails to match.
 * Usage: npx tsx tools/dedupe-diag.ts <compiled.json>
 */
import fs from 'fs';
import { deobfuscateFactorySource } from '../src/deobfuscator/index';
import { decompileScript, IntermediateStack } from '../src/decompiler/index';

const compiled = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
const listIds = new Set<string>();
for (const t of compiled.targets || []) for (const k of Object.keys(t.lists || {})) listIds.add(k);

const sig = (s: any): string => {
    if (!(s instanceof IntermediateStack)) return '';
    return s.blocks.map((b: any) => {
        const parts = Object.entries(b.inputs || {})
            .filter(([, v]) => v instanceof IntermediateStack)
            .map(([k, v]) => `${k}:${sig(v)}`);
        return `${b.opcode}(${parts.join(',')})`;
    }).join(';');
};

for (const [k, t] of Object.entries<any>(compiled.compiledTargets || {})) {
    const hatIds = new Set<string>((t.hats || []).map((h: any) => h.topBlockId));
    const scripts: Record<string, string> = {};
    for (const [id, s] of Object.entries<any>(t.scripts || {})) {
        const src = deobfuscateFactorySource(s.factorySource || '').source;
        const sc = decompileScript(src, { listIds });
        const blocks = sc.stack!.blocks;
        if (blocks.length && blocks[blocks.length - 1].opcode === 'control.stopScript') blocks.pop();
        scripts[id] = sig(sc.stack);
    }
    const procs: Record<string, string> = {};
    for (const [v, p] of Object.entries<any>(t.procedures || {})) {
        const src = deobfuscateFactorySource(p.factorySource || '').source;
        const sc = decompileScript(src, { variant: v, listIds });
        const blocks = sc.stack!.blocks;
        if (blocks.length && blocks[blocks.length - 1].opcode === 'control.stopScript') blocks.pop();
        procs[v] = sig(sc.stack);
    }

    const taken = new Set<string>();
    for (const pass of ['exact', 'prefix'] as const) {
        for (const [v, ps] of Object.entries(procs)) {
            if (!ps) continue;
            for (const id of Object.keys(scripts)) {
                if (taken.has(id) || hatIds.has(id)) continue;
                const ss = scripts[id];
                if (!ss) continue;
                const ok = pass === 'exact' ? ss === ps : (ps.startsWith(ss + ';') || ss.startsWith(ps + ';'));
                if (ok) { taken.add(id); break; }
            }
        }
    }
    const unmatched = Object.keys(procs).filter(v => {
        const ps = procs[v];
        if (!ps) return false;
        return !Object.keys(scripts).some(id => taken.has(id) &&
            (scripts[id] === ps || ps.startsWith(scripts[id] + ';') || scripts[id].startsWith(ps + ';')));
    });
    console.log(`\n### target ${k} ${t.name}: scripts=${Object.keys(scripts).length} procedures=${Object.keys(procs).length} matched=${taken.size}`);
    for (const v of unmatched) {
        console.log(`  UNMATCHED proc ${JSON.stringify(v)}`);
        console.log(`    proc sig : ${procs[v].slice(0, 200)}`);
        // closest script by shared leading blocks
        let best = '', bestN = -1;
        for (const id of Object.keys(scripts)) {
            if (hatIds.has(id)) continue;
            const a = scripts[id].split(';'), b = procs[v].split(';');
            let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++;
            if (n > bestN) { bestN = n; best = id; }
        }
        console.log(`    closest script ${JSON.stringify(best)} (${bestN} shared leading blocks): ${scripts[best]?.slice(0, 200)}`);
    }
}
