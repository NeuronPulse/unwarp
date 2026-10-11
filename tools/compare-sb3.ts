/**
 * Compare two .sb3 files structurally (block counts per opcode, per target).
 *
 * Usage: npx tsx tools/compare-sb3.ts <reference.sb3> <candidate.sb3>
 */
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: compare-sb3.ts <ref.sb3> <cand.sb3>'); process.exit(1); }

async function load(p: string) {
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    return JSON.parse(await zip.file('project.json').async('string'));
}

function counts(blocks: Record<string, any>) {
    const m = new Map<string, number>();
    for (const blk of Object.values(blocks || {})) {
        if (!blk || typeof blk !== 'object') continue;
        if (blk.shadow) continue;
        m.set(blk.opcode, (m.get(blk.opcode) ?? 0) + 1);
    }
    return m;
}

function scripts(blocks: Record<string, any>) {
    const norm: Record<string, any> = {};
    for (const [k, v] of Object.entries(blocks || {})) norm[k] = { ...v, id: v.id ?? k };
    return Object.values(norm).filter((x: any) => x.topLevel)
        .map((x: any) => x.opcode === 'procedures_definition'
            ? 'DEF:' + (norm[x.inputs?.custom_block?.[1]]?.mutation?.proccode ?? '?')
            : x.opcode);
}

async function main() {
    const A = await load(a);
    const B = await load(b);
    console.log(`ref targets=${A.targets.length}  cand targets=${B.targets.length}`);

    const allOps = new Set<string>();
    const totals = { a: 0, b: 0 };
    const perOp = new Map<string, [number, number]>();

    for (let i = 0; i < Math.max(A.targets.length, B.targets.length); i++) {
        const ta = A.targets[i], tb = B.targets[i];
        const ca = counts(ta?.blocks), cb = counts(tb?.blocks);
        for (const op of new Set([...ca.keys(), ...cb.keys()])) allOps.add(op);
        const na = ta?.name ?? '(none)', nb = tb?.name ?? '(none)';
        const sa = scripts(ta?.blocks), sb = scripts(tb?.blocks);
        let diff = 0;
        for (const op of new Set([...ca.keys(), ...cb.keys()])) diff += Math.abs((ca.get(op) ?? 0) - (cb.get(op) ?? 0));
        console.log(`\n[${i}] ${na}${na !== nb ? ' / ' + nb : ''}: scripts ref=${sa.length} cand=${sb.length}  blockdiff=${diff}`);
        if (sa.length !== sb.length) {
            const ca2 = sa.slice().sort(), cb2 = sb.slice().sort();
            const only = (x: string[], y: string[]) => {
                const yy = [...y];
                const out: string[] = [];
                for (const v of x) { const k = yy.indexOf(v); if (k >= 0) yy.splice(k, 1); else out.push(v); }
                return out;
            };
            console.log('   only in ref :', only(ca2, cb2).join(', ') || '-');
            console.log('   only in cand:', only(cb2, ca2).join(', ') || '-');
        }
    }

    for (const op of allOps) {
        let x = 0, y = 0;
        for (let i = 0; i < Math.max(A.targets.length, B.targets.length); i++) {
            x += counts(A.targets[i]?.blocks).get(op) ?? 0;
            y += counts(B.targets[i]?.blocks).get(op) ?? 0;
        }
        perOp.set(op, [x, y]);
        totals.a += x; totals.b += y;
    }

    console.log(`\ntotal non-shadow blocks: ref=${totals.a} cand=${totals.b}`);
    console.log('\nopcode diffs (ref -> cand):');
    const rows = [...perOp].filter(([, [x, y]]) => x !== y).sort((p, q) => Math.abs(q[1][0] - q[1][1]) - Math.abs(p[1][0] - p[1][1]));
    for (const [op, [x, y]] of rows) {
        console.log(`  ${op.padEnd(42)} ${String(x).padStart(6)} -> ${String(y).padStart(6)}  ${y < x ? 'LOST ' + (x - y) : 'EXTRA ' + (y - x)}`);
    }
    if (!rows.length) console.log('  (none)');
}
main().catch(e => { console.error(e); process.exit(1); });
