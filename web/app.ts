import { decompileScript, linkSources } from '../src/decompiler/index';
import { parse } from 'acorn';
import { initI18n, setLocale, t } from './i18n';
import { unpackageHTML } from '../src/unpackager/index';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const sourceEl = $<HTMLTextAreaElement>('source');
const outputEl = $<HTMLPreElement>('output');
const toastEl = $('toast');

let lastText = '';          // last produced text for copy/download
let lastKind: 'ir' | 'ast' | 'src' = 'ir';
let hasDecompiled = false;  // true once a script has been decompiled this session

initI18n();

// Locale switch (system / light / dark mirror the theme select below)
document.querySelector<HTMLSelectElement>('#locale-select')?.addEventListener('change', (e) => {
  setLocale((e.target as HTMLSelectElement).value);
  // Re-sync the initial output placeholder if nothing has been decompiled yet.
  if (!hasDecompiled) {
    const initial = t('output.initial');
    tabContent.ir = initial;
    if (lastKind === 'ir') renderOutput('ir');
  }
  updateImportUI();
  refreshJsStatus();
  refreshUnpackStatus();
  if (unpackBlobUrl) refreshUnpackDownloadLink();
});

// ---------------------------------------------------------------------------
// Theme (system / light / dark): the theme is stored on the <html> element as a
// `theme` attribute; `system` resolves to the OS preference. Persisted in
// localStorage.
// ---------------------------------------------------------------------------
const THEME_KEY = 'unwarp.theme';
const POSSIBLE_THEMES = ['system', 'light', 'dark'];

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
let systemTheme: 'light' | 'dark' = darkMedia.matches ? 'dark' : 'light';
if (darkMedia.addEventListener) {
  darkMedia.addEventListener('change', () => {
    systemTheme = darkMedia.matches ? 'dark' : 'light';
    if (currentTheme === 'system') applyTheme('system');
  });
}

let currentTheme = 'system';

function applyTheme(theme: string) {
  currentTheme = theme;
  document.documentElement.setAttribute('theme', theme === 'system' ? systemTheme : theme);
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* ignore */ }
  const sel = document.querySelector<HTMLSelectElement>('#theme-select');
  if (sel) sel.value = theme;
}

(function initTheme() {
  let theme = 'system';
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (POSSIBLE_THEMES.includes(stored || '')) theme = stored as string;
  } catch { /* ignore */ }
  applyTheme(theme);
})();

document.querySelector<HTMLSelectElement>('#theme-select')?.addEventListener('change', (e) => {
  applyTheme((e.target as HTMLSelectElement).value);
});

// ---------------------------------------------------------------------------
// Input-mode radios (single script / multi-script + procedures / 02Engine HTML / kylin)
// ---------------------------------------------------------------------------
type ImportMode = 'js-single' | 'js-multi' | 'o2engine' | 'kylin';

const importModeEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="input-mode"]'));
const importHintEl = $('import-hint');
const singleOpts = $('single-opts');
const jsInputArea = $('js-input');
const jsActions = $('js-actions');
const jsActionsExample = $('js-actions-example');
const jsActionsClear = $('js-actions-clear');
const htmlActions = $('html-actions');
const debugSection = $('debug-section');
const outputJsView = $('output-js-view');
const outputProjectView = $('output-project-view');
const runBtn = $<HTMLButtonElement>('run-btn');

function currentMode(): ImportMode {
  const checked = importModeEls.find((el) => el.checked);
  const v = checked?.value;
  if (v === 'js-multi' || v === 'o2engine' || v === 'kylin') return v;
  return 'js-single';
}

const HINT_KEYS: Record<ImportMode, string> = {
  'js-single': 'input.hint.single',
  'js-multi': 'input.hint.multi',
  o2engine: 'input.hint.o2engine',
  kylin: 'input.hint.kylin',
};
const RUN_LABEL_KEYS: Record<ImportMode, string> = {
  'js-single': 'input.run',
  'js-multi': 'input.run',
  o2engine: 'unpack.run',
  kylin: 'input.run',
};

function updateImportUI() {
  const mode = currentMode();
  const isJs = mode === 'js-single' || mode === 'js-multi';

  jsInputArea.hidden = !isJs;
  jsActions.hidden = !isJs;
  jsActionsExample.hidden = !isJs;
  jsActionsClear.hidden = !isJs;
  htmlActions.hidden = mode !== 'o2engine';
  singleOpts.hidden = mode !== 'js-single';
  debugSection.hidden = !isJs;
  outputJsView.hidden = !isJs;
  outputProjectView.hidden = isJs;

  importHintEl.dataset.i18nHtml = HINT_KEYS[mode];
  importHintEl.innerHTML = t(HINT_KEYS[mode]);

  const runLabelKey = RUN_LABEL_KEYS[mode];
  runBtn.dataset.i18n = runLabelKey;
  runBtn.textContent = t(runLabelKey);
  runBtn.disabled = mode === 'kylin';
}
importModeEls.forEach((el) => el.addEventListener('change', updateImportUI));
updateImportUI();

// ---------------------------------------------------------------------------
// File load / example / clear
// ---------------------------------------------------------------------------
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { sourceEl.value = String(reader.result); };
  reader.readAsText(file);
});

const EXAMPLE = `(function factory (thread) {
  const target = thread.target;
  const runtime = target.runtime;
  const stage = runtime.getTargetForStage();
  const b0 = target.variables["V1"];
  return function* gen () {
    target.setXY(100, target.y);
    b0.value = "hello";
    runtime.monitorBlocks.changeBlock({ id: "V1", element: "checkbox", value: true }, runtime);
    runtime.requestRedraw();
    yield;
  };
})`;

$('example-btn').addEventListener('click', () => { sourceEl.value = EXAMPLE; });
$('clear-btn').addEventListener('click', () => { sourceEl.value = ''; sourceEl.focus(); });

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabEls = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
function selectTab(name: string) {
  tabEls.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  lastKind = name as any;
  outputEl.classList.remove('error');
  renderOutput(name);
}
tabEls.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab!)));

// ---------------------------------------------------------------------------
// Status line above the output (mirrors the packager's progress text: result
// feedback lives next to the output instead of a hidden "errors" tab).
// ---------------------------------------------------------------------------
const jsStatusEl = $('js-status');
let jsStatus: 'done' | 'error' | null = null;

function refreshJsStatus() {
  if (jsStatus === 'done') {
    jsStatusEl.textContent = t('output.status.done');
    jsStatusEl.classList.remove('error');
  } else if (jsStatus === 'error') {
    jsStatusEl.textContent = t('output.status.error');
    jsStatusEl.classList.add('error');
  } else {
    jsStatusEl.textContent = '';
    jsStatusEl.classList.remove('error');
  }
}

function setJsStatus(kind: 'done' | 'error' | null) {
  jsStatus = kind;
  refreshJsStatus();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// ACORN parse options (for AST view)
// ---------------------------------------------------------------------------
function acornOptions(): any {
  const sel = $<HTMLSelectElement>('acorn-opts').value;
  const base: any = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true };
  if (sel === 'locations') return { ...base, locations: true };
  if (sel === 'all') return { ...base, locations: true, comment: true, onComment: [] as any[] };
  return base;
}

// ---------------------------------------------------------------------------
// IR serializer — drops noisy bookkeeping fields; honors the flags/metadata toggles
// ---------------------------------------------------------------------------
const META_FIELDS = new Set(['topBlockId', 'executableHat', 'arguments']);

function clean(node: any, showFlags: boolean, hideMeta = false): any {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((n) => clean(n, showFlags, hideMeta));
  if (typeof node === 'object') {
    if (Array.isArray(node.blocks)) return { blocks: node.blocks.map((b: any) => clean(b, showFlags, hideMeta)) };
    const out: any = {};
    for (const k of Object.keys(node)) {
      if (k === 'cachedCompileResult' || k === 'cachedAnalysisEndState') continue;
      if (hideMeta && META_FIELDS.has(k)) continue;
      if (!showFlags && (k === 'yields' || k === 'warpTimer' || k === 'ignoreState' || k === 'entryState' || k === 'exitState')) continue;
      out[k] = clean(node[k], showFlags, hideMeta);
    }
    return out;
  }
  return node;
}

function serialize(value: any): string {
  const compact = $<HTMLInputElement>('opt-compact').checked;
  return JSON.stringify(value, null, compact ? 0 : 2);
}

// ---------------------------------------------------------------------------
// Minimal syntax highlighting for the output (JSON for IR/AST, JS for source).
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function highlight(code: string, mode: 'json' | 'js' | null): string {
  if (!mode) return escapeHtml(code);
  const out: string[] = [];
  const push = (text: string, cls?: string) => {
    const esc = escapeHtml(text);
    out.push(cls ? `<span class="tok-${cls}">${esc}</span>` : esc);
  };
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    if (mode === 'js' && c === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i);
      push(code.slice(i, j === -1 ? len : j), 'comment');
      i = j === -1 ? len : j;
      continue;
    }
    if (mode === 'js' && c === '/' && code[i + 1] === '*') {
      const j = code.indexOf('*/', i + 2);
      const end = j === -1 ? len : j + 2;
      push(code.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < len) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j += 1; break; }
        j++;
      }
      let cls = 'string';
      if (mode === 'json' && c === '"') {
        const after = code.slice(j).replace(/\s/g, '');
        if (after.startsWith(':')) cls = 'key';
      }
      push(code.slice(i, j), cls);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      let cls: string | undefined;
      if (mode === 'json') {
        if (word === 'true' || word === 'false') cls = 'bool';
        else if (word === 'null') cls = 'keyword';
      } else if (JS_KEYWORDS.has(word)) {
        cls = 'keyword';
      }
      if (cls) push(word, cls); else push(word);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = code.slice(i).match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
      push(m![0], 'number');
      i += m![0].length;
      continue;
    }
    push(c);
    i++;
  }
  return out.join('');
}

function outputMode(name: string): 'json' | 'js' | null {
  if (name === 'ir' || name === 'ast') return 'json';
  if (name === 'src') return 'js';
  return null;
}

// ---------------------------------------------------------------------------
// Decompile
// ---------------------------------------------------------------------------
function parseListIds(): Set<string> {
  const raw = $<HTMLInputElement>('listids').value.trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function run() {
  const mode = currentMode();
  if (mode === 'o2engine') {
    // Project mode: the .html file selection drives the unpack; the run button
    // re-triggers it only if a file was already chosen.
    if (lastHtmlFile) void unpackFile(lastHtmlFile);
    else toast(t('toast.noHtmlFile'));
    return;
  }
  if (mode === 'kylin') return;

  const src = sourceEl.value;
  if (!src.trim()) { toast(t('toast.noSource')); return; }

  const showFlags = $<HTMLInputElement>('opt-yields').checked;
  const hideMeta = $<HTMLInputElement>('opt-hidemeta').checked;
  const strict = $<HTMLInputElement>('opt-strict').checked;

  outputEl.classList.remove('error');

  try {
    let irText: string;
    // What the AST / source tabs operate on: the entry script in multi mode,
    // the pasted source in single mode.
    let srcForTabs = src;
    let astSource = src;

    if (mode === 'js-multi') {
      const obj = JSON.parse(src);
      if (typeof obj.entry !== 'string') throw new Error(t('run.multiError'));
      const { ir, missing } = linkSources(obj.entry, obj.procedures ?? {});
      if (missing.length && strict) throw new Error(t('run.missingProcedures') + missing.join(', '));
      const cleaned = clean(ir, showFlags, hideMeta);
      if (missing.length) (cleaned as any).__missingProcedures = missing;
      irText = serialize(cleaned);
      srcForTabs = obj.entry;
      astSource = obj.entry;
    } else {
      const opts: any = {};
      const variant = $<HTMLInputElement>('variant').value.trim();
      if (variant) opts.variant = variant;
      const listIds = parseListIds();
      if (listIds.size) opts.listIds = listIds;
      const script = decompileScript(src, opts);
      irText = serialize(clean(script, showFlags, hideMeta));
    }

    // IR and AST are both always produced; switch between them with the top tab bar.
    setTabContent('ir', irText);
    hasDecompiled = true;
    try {
      const ast = parse(astSource, acornOptions());
      setTabContent('ast', serialize(clean(ast, true)));
    } catch (e: any) {
      setTabContent('ast', `${t('ast.failed')}: ${e.message}`);
    }
    setTabContent('src', srcForTabs);

    lastText = irText;

    setJsStatus('done');
    selectTab('ir');
  } catch (e: any) {
    // Errors render inline in the output pane (with an error border) instead of
    // hiding behind a dedicated tab; previous results stay browsable.
    const msg = e && e.message ? e.message : String(e);
    const detail = e && e.stack ? e.stack : msg;
    lastText = detail;
    outputEl.classList.add('error');
    outputEl.textContent = detail;
    setJsStatus('error');
    tabEls.forEach((tb) => tb.classList.remove('active'));
    lastKind = 'ir';
  }
}

const tabContent: Record<string, string> = { ir: '', ast: '', src: '' };
function renderOutput(name: string) {
  outputEl.classList.remove('error');
  outputEl.innerHTML = highlight(tabContent[name] || '', outputMode(name));
}
function setTabContent(name: string, text: string) {
  tabContent[name] = text;
  if (lastKind === name) renderOutput(name);
}

$('run-btn').addEventListener('click', run);

// Ctrl/Cmd+Enter to run (JS modes only)
sourceEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    const mode = currentMode();
    if (mode === 'js-single' || mode === 'js-multi') run();
  }
});

// ---------------------------------------------------------------------------
// Copy / download
// ---------------------------------------------------------------------------
$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastText);
    toast(t('toast.copied'));
  } catch {
    toast(t('toast.copyFailed'));
  }
});

$('download-btn').addEventListener('click', () => {
  const blob = new Blob([lastText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ext = lastKind === 'src' ? 'js' : 'json';
  a.href = url;
  a.download = `unwarp-${lastKind}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
});

// initial tab content empty
setTabContent('ir', t('output.initial'));

// ---------------------------------------------------------------------------
// 02Engine HTML → SB3 project mode.
// Selecting a file starts the unpack immediately (mirrors the packager's
// "select a file → it loads" flow); re-selecting the same file retries.
// The result is offered as a centered blob download link (mirrors the
// packager's Downloads section: link text carries the filename + size).
// ---------------------------------------------------------------------------
const htmlFileEl = $<HTMLInputElement>('html-file');
const unpackStatusEl = $<HTMLParagraphElement>('unpack-status');
const unpackOutputEl = $<HTMLPreElement>('unpack-output');
const unpackDownloadArea = $('unpack-download-area');
const unpackDownloadLink = $<HTMLAnchorElement>('unpack-download-link');

let lastHtmlFile: File | null = null;
let unpackBlobUrl: string | null = null;
let unpackFileName = 'project.sb3';
let unpackBlobSize = 0;
/** None until a run happens; survives locale switches for re-rendering. */
let unpackState: null | { kind: 'processing' } | { kind: 'done'; plain: boolean; warnings: number } | { kind: 'error'; message: string } = null;

/** Let the browser paint the "processing" status before the synchronous heavy work. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function revokeUnpackUrl() {
  if (unpackBlobUrl) {
    URL.revokeObjectURL(unpackBlobUrl);
    unpackBlobUrl = null;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(2)}MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)}KB`;
  return `${bytes}B`;
}

function refreshUnpackStatus() {
  if (!unpackState) {
    unpackStatusEl.textContent = t('unpack.placeholder');
    unpackStatusEl.classList.remove('error');
    return;
  }
  if (unpackState.kind === 'processing') {
    unpackStatusEl.textContent = t('unpack.processing');
    unpackStatusEl.classList.remove('error');
    return;
  }
  if (unpackState.kind === 'error') {
    unpackStatusEl.textContent = t('unpack.error');
    unpackStatusEl.classList.add('error');
    return;
  }
  let msg = unpackState.plain ? t('unpack.donePlain') : t('unpack.done');
  if (unpackState.warnings > 0) msg += t('unpack.warnings').replace('{n}', String(unpackState.warnings));
  unpackStatusEl.textContent = msg;
  unpackStatusEl.classList.remove('error');
}
refreshUnpackStatus();

async function unpackFile(file: File) {
  unpackFileName = file.name.replace(/\.x?html?$/i, '') + '.sb3';
  unpackState = { kind: 'processing' };
  refreshUnpackStatus();
  unpackOutputEl.hidden = true;
  unpackDownloadArea.hidden = true;
  revokeUnpackUrl();
  await nextPaint();

  try {
    const text = await file.text();
    const { sb3, warnings, mode } = await unpackageHTML(text);

    unpackState = { kind: 'done', plain: mode === 'plain', warnings: warnings.length };
    refreshUnpackStatus();

    if (warnings.length > 0) {
      unpackOutputEl.hidden = false;
      unpackOutputEl.classList.remove('error');
      unpackOutputEl.textContent = warnings.join('\n');
    }

    const blob = new Blob([sb3], { type: 'application/zip' });
    unpackBlobSize = blob.size;
    unpackBlobUrl = URL.createObjectURL(blob);
    unpackDownloadLink.href = unpackBlobUrl;
    unpackDownloadLink.download = unpackFileName;
    refreshUnpackDownloadLink();
    unpackDownloadArea.hidden = false;
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    unpackState = { kind: 'error', message: msg };
    refreshUnpackStatus();
    unpackOutputEl.hidden = false;
    unpackOutputEl.classList.add('error');
    unpackOutputEl.textContent = msg;
  }
}

function refreshUnpackDownloadLink() {
  unpackDownloadLink.textContent = t('unpack.downloadLink')
    .replace('{filename}', unpackFileName)
    .replace('{size}', formatSize(unpackBlobSize));
}

htmlFileEl.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset so that picking the same file again still fires `change` (retry).
  input.value = '';
  if (!file) return;
  lastHtmlFile = file;
  await unpackFile(file);
});

// Don't leak the blob URL on navigation away.
window.addEventListener('pagehide', revokeUnpackUrl);
