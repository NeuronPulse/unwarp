/**
 * Behavioral equivalence checker (deterministic).
 *
 * Runs ORIGINAL and RESTORED .sb3 through scratch-vm's compiler (same engine
 * 02packager/TurboWarp use) for the same frames, then compares every observable
 * variable / list value at several checkpoints. Deterministic timer + RNG so a
 * difference means a REAL behavioral change (not wall-clock / random noise).
 *
 * Usage: npx tsx tools/equiv.ts <orig.sb3> <restored.sb3> [maxFrames]
 *   env: NO_EXT=1  -> skip loading external (URL) extensions
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const VM = require('../02scratch-vm/src/virtual-machine.js');
const JSZip = require('@turbowarp/jszip');

// deterministic RNG so both runs get the same random sequence
function mulberry32(seed: number) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function snapshot(vm: any) {
    const state: Record<string, any> = {};
    const targets = [vm.runtime.getTargetForStage(), ...vm.runtime.targets];
    for (const t of targets) {
        if (!t) continue;
        const scope = t.isStage ? 'stage' : (t.getName?.() ?? 'sprite');
        for (const id in t.variables) {
            const v = t.variables[id];
            const key = `${scope}::${v.name}`;
            state[key] = v.type === 'list' ? [...(v.value ?? [])] : v.value;
        }
    }
    return state;
}

function diff(a: Record<string, any>, b: Record<string, any>) {
    const onlyA: string[] = [], onlyB: string[] = [], changed: string[] = [];
    for (const k of Object.keys(a)) {
        if (!(k in b)) onlyA.push(k);
        else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(`${k}: ${JSON.stringify(a[k]).slice(0, 60)} -> ${JSON.stringify(b[k]).slice(0, 60)}`);
    }
    for (const k of Object.keys(b)) if (!(k in a)) onlyB.push(k);
    return { onlyA, onlyB, changed };
}

async function run(file: string, maxFrames: number, checkpoints: number[]) {
    const buf = fs.readFileSync(path.resolve(file));
    const vm: any = new VM();
    vm.setCompilerOptions({ enabled: true, warpTimer: true });
    if (process.env.NO_EXT && vm.securityManager) {
        vm.securityManager.canLoadExtensionFromProject = () => false;
    }
    // Load the parsed project object directly; sanitize costume assetIds (which the
    // compiler normalizes to non-conforming values for synthetic test projects) so
    // the SB3 schema validation passes. Costumes are not exercised by the VM logic.
    const zip = await JSZip.loadAsync(buf);
    const pj = JSON.parse(await zip.file('project.json').async('string'));
    for (const t of pj.targets || []) for (const c of t.costumes || []) {
        if (!/^[a-fA-F0-9]{32}$/.test(c.assetId || '')) {
            c.assetId = '0'.repeat(32);
            if (typeof c.md5ext === 'string') c.md5ext = c.assetId + '.svg';
        }
    }
    await vm.loadProject(pj);
    vm.greenFlag();
    // make timer + random deterministic: stub the RNG (both the VM runtime RNG and the
    // global Math.random that `pick random` uses) with a fixed seed, and drive the
    // clock ourselves. Both the original and restored runs use the SAME seed so any
    // divergence comes from decompiler differences, not from RNG/timer noise.
    const prng = mulberry32(0x1234abcd);
    const prevRandom = Math.random;
    Math.random = prng;
    if (vm.runtime) vm.runtime.random = prng;
    // make timer deterministic: stop auto-update, drive currentMSecs ourselves
    vm.runtime.updateCurrentMSecs = () => {};
    const snaps: Record<string, any>[] = [];
    let cp = 0;
    let error: string | null = null;
    for (let f = 1; f <= maxFrames; f++) {
        vm.runtime.currentMSecs = f * (1000 / 30);
        try {
            vm.runtime._step();
        } catch (e: any) {
            if (!error) error = `threw at frame ${f}: ${e?.message || e}`;
            // keep stepping so later checkpoints still snapshot what we can
        }
        if (f === checkpoints[cp]) { snaps.push(snapshot(vm)); cp++; }
    }
    return { vm, snaps, error };
}

async function main() {
    const [, , orig, rest, framesArg] = process.argv;
    if (!orig || !rest) { console.error('usage: equiv.ts <orig.sb3> <restored.sb3> [maxFrames]'); process.exit(1); }
    const maxFrames = parseInt(framesArg ?? '800', 10);
    const checkpoints = [...new Set([50, 200, maxFrames])].filter((v) => v <= maxFrames).sort((a, b) => a - b);
    // reset rng before each run so both see identical random sequence
    (Math as any).random = mulberry32(0x1234abcd);
    const o = await run(orig, maxFrames, checkpoints);
    (Math as any).random = mulberry32(0x1234abcd);
    const r = await run(rest, maxFrames, checkpoints);

    let allOk = true;
    for (let i = 0; i < checkpoints.length; i++) {
        const cp = checkpoints[i];
        const a = o.snaps[i] ?? {};
        const b = r.snaps[i] ?? {};
        const d = diff(a, b);
        const errs = [...(o.vm.runtime.errors ?? []), ...(r.vm.runtime.errors ?? [])];
        const ok = Object.keys(a).length > 0 && Object.keys(b).length > 0 && !d.changed.length && !d.onlyA.length && !d.onlyB.length && !errs.length && !o.error && !r.error;
        console.log(`--- checkpoint frame ${cp}: ${ok ? 'EQUIVALENT ✅' : 'DIFFERENT ❌'}`);
        if (!ok) {
            allOk = false;
            if (o.error) console.log(`   ORIG threw: ${o.error}`);
            if (r.error) console.log(`   REST threw: ${r.error}`);
            if (d.changed.length) { console.log(`   CHANGED(${d.changed.length}):`); d.changed.slice(0, 30).forEach(x => console.log('     ' + x)); }
            if (d.onlyA.length) console.log(`   only in ORIG(${d.onlyA.length}): ${d.onlyA.slice(0, 15).join(', ')}`);
            if (d.onlyB.length) console.log(`   only in REST(${d.onlyB.length}): ${d.onlyB.slice(0, 15).join(', ')}`);
            if (errs.length) console.log(`   errors: ${errs.slice(0, 5).map((e: any) => e?.message ?? e).join(' | ')}`);
        }
    }
    console.log(allOk ? '\nRESULT: behaviorally equivalent across all checkpoints' : '\nRESULT: behavioral difference detected');
}
main().catch(e => { console.error('FAILED:', e?.stack || e); process.exit(1); });
