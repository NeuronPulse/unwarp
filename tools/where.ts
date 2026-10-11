import fs from 'fs';
import { createRequire } from 'module';
import { rebuildProjectJSON } from '../src/unpackager/index';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');

async function main() {
  const zip = await JSZip.loadAsync(fs.readFileSync(process.env.HOME + '/下载/lisp.sb3'));
  const origJSON = JSON.parse(await zip.file('project.json').async('string'));
  const compiled = JSON.parse(fs.readFileSync('/tmp/lisp.compiled.json', 'utf8'));
  const stripped: any = { ...origJSON, targets: compiled.targets };
  const { warnings } = rebuildProjectJSON(stripped, compiled);
  for (const w of warnings) console.log('WARN', w);

  const blocks = stripped.targets[1].blocks as Record<string, any>;
  const withIds: Record<string, any> = {};
  for (const [k, v] of Object.entries(blocks)) withIds[k] = { ...v, id: v.id ?? k };
  const top = (id: string) => { let p = id; while (withIds[p] && withIds[p].parent) p = withIds[p].parent; return withIds[p]; };
  const label = (t: any) => t.opcode === 'procedures_definition'
    ? 'DEF:' + withIds[t.inputs.custom_block[1]].mutation.proccode
    : t.opcode + '#' + t.id;

  const hist = (src: Record<string, any>, opcode: string) => {
    const norm: Record<string, any> = {};
    for (const [k, v] of Object.entries(src)) norm[k] = { ...v, id: v.id ?? k };
    const topOf = (id: string) => { let p = id; while (norm[p] && norm[p].parent) p = norm[p].parent; return norm[p]; };
    const nameOf = (t: any) => t.opcode === 'procedures_definition'
      ? 'DEF:' + norm[t.inputs.custom_block[1]].mutation.proccode
      : t.opcode + '#' + t.id;
    const m: Record<string, number> = {};
    for (const [id, b] of Object.entries(norm)) {
      if (b.opcode !== opcode) continue;
      const t = topOf(id);
      const l = t ? nameOf(t) : 'ORPHAN';
      m[l] = (m[l] ?? 0) + 1;
    }
    return m;
  };
  if (process.env.TREE) {
    const show = (src: Record<string, any>, title: string) => {
      const norm: Record<string, any> = {};
      for (const [k, v] of Object.entries(src)) norm[k] = { ...v, id: v.id ?? k };
      const roots = Object.values(norm).filter((b: any) => b.topLevel);
      const walk = (id: any, d = 0): string[] => {
        const b = norm[id];
        if (!b) return ['  '.repeat(d) + '<?' + id + '>'];
        const out = ['  '.repeat(d) + b.opcode + (b.fields && Object.keys(b.fields).length ? ' ' + JSON.stringify(b.fields) : '')];
        for (const [k, v] of Object.entries(b.inputs || {})) {
          const arr = v as any[];
          const payload = arr[1];
          if (typeof payload === 'string') out.push(...walk(payload, d + 1));
          else out.push('  '.repeat(d + 1) + k + ' = ' + JSON.stringify(payload));
        }
        if (b.next) out.push(...walk(b.next, d));
        return out;
      };
      for (const r of roots) {
        const isEval = r.opcode === 'procedures_definition' &&
          norm[(r as any).inputs.custom_block[1]]?.mutation?.proccode === 'eval';
        if (!isEval) continue;
        console.log('\n===== ' + title + ' =====');
        console.log(walk((r as any).id).join('\n'));
      }
    };
    show(withIds, 'REBUILT eval');
    show(origJSON.targets[1].blocks, 'ORIG eval');
    return;
  }

  for (const op of ['data_itemoflist', 'data_setvariableto', 'control_if', 'control_repeat_until']) {
    console.log(op, '\n  rebuilt:', JSON.stringify(hist(withIds, op)), '\n  orig   :', JSON.stringify(hist(origJSON.targets[1].blocks, op)));
  }
}
main();
