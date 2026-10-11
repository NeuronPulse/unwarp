/**
 * 02Engine packager HTML → .sb3 unpackager.
 *
 * Extracts compiled-project data and asset archive from an 02packager-generated HTML
 * file, deobfuscates + decompiles every factory source back to Scratch IR, serializes
 * the IR to SB3 blocks, and reassembles a complete .sb3 zip.
 *
 * The 02packager embeds data in two places:
 *  1. Asset archive (zip with stripped project.json + costumes/sounds) → base85-encoded
 *     in `<script type="application/x-o2-project-chunk" data-size="N">` tags.
 *  2. Compiled-project metadata (JSON with factorySource strings) → URI-encoded string
 *     inside the bootstrap `getProjectData()` function.
 *
 * It also recognizes the *plain* (uncompiled) 02Engine embedding: the whole project
 * zip is base85-encoded into `<script data="…">decodeChunk(N)</script>` tags. No
 * factory sources exist there, so the archive is returned as-is (mode: 'plain').
 */
import { deobfuscateFactorySource } from '../deobfuscator/index';
import { decompileScript, linkSources, IntermediateStack, StackOpcode } from '../decompiler/index';
import {
    serializeTargetBlocks, buildProcedureInfo,
    type SerializeContext, type TargetIR, type HatData,
} from '../serializer/index';

// ---------------------------------------------------------------------------
// JSZip — works in both Node.js (require) and browser (esbuild bundle).
// ---------------------------------------------------------------------------
let JSZip: any = null;
try {
    // Node.js
    JSZip = require('@turbowarp/jszip');
} catch {
    // Browser — will be injected by esbuild bundler
    JSZip = null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnpackageResult {
    sb3: Uint8Array;
    warnings: string[];
    /**
     * How the HTML was recognized:
     *  - 'compiled': 02packager precompiled HTML — every script was decompiled from
     *    factory sources and the blocks rebuilt.
     *  - 'plain': uncompiled 02Engine HTML — the embedded project archive already
     *    contains complete blocks and was extracted as-is (nothing to decompile).
     */
    mode: 'compiled' | 'plain';
}

export interface CompiledProjectData {
    format?: string;
    compiledTargets: Record<string, {
        scripts: Record<string, { factorySource?: string; executableHat?: boolean }>;
        procedures: Record<string, { factorySource?: string }>;
        hats: HatData[];
    }>;
    targets: any[];
    monitors: any[];
    meta?: any;
    extensionURLs?: any;
}

// ---------------------------------------------------------------------------
// Base85 decoder — adapted from 02packager/src/packager/base85.js.
// Character set: 0x2a–0x7e of ASCII, with 0x3c (<)→0x28 and 0x3e (>)→0x29 for HTML safety.
// Little-endian, no length header (version 4).
// ---------------------------------------------------------------------------

function getBase85DecodeValue(code: number): number {
    if (code === 0x28) code = 0x3c;
    if (code === 0x29) code = 0x3e;
    return code - 0x2a;
}

/**
 * Decode base85 string into a pre-allocated ArrayBuffer at the given offset.
 * Each group of 5 characters → 4 bytes (little-endian Uint32).
 */
function base85decode(str: string, outBuffer: ArrayBuffer, outOffset: number): void {
    const view = new DataView(outBuffer, outOffset, Math.floor(str.length / 5) * 4);
    for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
        view.setUint32(j, (
            getBase85DecodeValue(str.charCodeAt(i + 4)) * 85 * 85 * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 3)) * 85 * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 2)) * 85 * 85 +
            getBase85DecodeValue(str.charCodeAt(i + 1)) * 85 +
            getBase85DecodeValue(str.charCodeAt(i))
        ), true);
    }
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

/** Match all `<script type="application/x-o2-project-chunk" data-size="N">CONTENT</script>` tags. */
function extractProjectChunks(html: string): { text: string; size: number }[] {
    const re = /<script\s+type="application\/x-o2-project-chunk"\s+data-size="(\d+)"\s*>([\s\S]*?)<\/script>/g;
    const chunks: { text: string; size: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        chunks.push({ text: m[2], size: Number(m[1]) });
    }
    return chunks;
}

/** Decode all project chunks into a single Uint8Array (the asset archive zip). */
function decodeProjectChunks(chunks: { text: string; size: number }[]): Uint8Array {
    const totalSize = chunks.reduce((a, c) => a + c.size, 0);
    const buffer = new ArrayBuffer(Math.ceil(totalSize / 4) * 4);
    let offset = 0;
    for (const chunk of chunks) {
        base85decode(chunk.text, buffer, offset);
        offset += chunk.size;
    }
    return new Uint8Array(buffer, 0, totalSize);
}

// ---------------------------------------------------------------------------
// Plain (uncompiled) 02Engine embedding: <script data="BASE85">decodeChunk(N)</script>
// ---------------------------------------------------------------------------

interface PlainDataChunk {
    text: string;
    /** decoded byte size of this chunk (the N in decodeChunk(N)) */
    size: number;
}

/**
 * Match all `<script data="…">…decodeChunk(N)…</script>` tags of the plain 02Engine
 * embedding. Note `data="` cannot match the compiled format's `data-size="` attribute,
 * because `data` must be followed directly by `=`.
 */
function extractPlainDataChunks(html: string): PlainDataChunk[] {
    const re = /<script\b[^>]*\sdata="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g;
    const chunks: PlainDataChunk[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const text = m[1];
        // The runtime advances its decode offset by the N passed to decodeChunk(N);
        // the call is wrapped in /*…*/ comments that also contain digits ("02Engine"),
        // so strip comments before reading the number.
        const call = m[2].match(/decodeChunk\s*\(([\s\S]*?)\)/);
        const stripped = call ? call[1].replace(/\/\*[\s\S]*?\*\//g, '') : '';
        const n = stripped.match(/\d+/);
        // The embedded size is authoritative; fall back to the full decoded length.
        const size = n ? Number(n[0]) : Math.floor(text.length / 5) * 4;
        if (size > 0) chunks.push({ text, size });
    }
    return chunks;
}

/**
 * Decode the plain 02Engine chunks (in DOM order, at the offsets the packager's
 * runtime uses) into the embedded project zip. Returns null when the result does
 * not look like a zip, i.e. this is not the plain 02Engine format.
 */
function decodePlainArchive(chunks: PlainDataChunk[]): Uint8Array | null {
    if (chunks.length === 0) return null;
    const totalSize = chunks.reduce((a, c) => a + c.size, 0);
    if (totalSize === 0) return null;
    const buffer = new ArrayBuffer(Math.ceil(totalSize / 4) * 4);
    let offset = 0;
    for (const chunk of chunks) {
        base85decode(chunk.text, buffer, offset);
        offset += chunk.size;
    }
    const bytes = new Uint8Array(buffer, 0, totalSize);
    // zip local-file header magic "PK\x03\x04" (or empty-archive "PK\x05\x06")
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
    return bytes;
}

/**
 * Extract the compiled-project metadata JSON from the bootstrap script.
 * The packager embeds it as `JSON.parse(decodeURIComponent("..."))`.
 */
function extractCompiledProjectData(html: string): CompiledProjectData {
    // Pattern: JSON.parse(decodeURIComponent("<URI-encoded JSON>"))
    // The encodeURIComponent output contains no unescaped double quotes (they become %22),
    // so the regex is safe — match until the closing ") that ends the call.
    const re = /JSON\.parse\(\s*decodeURIComponent\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*\)/g;
    let m: RegExpExecArray | null;
    let lastMatch: string | null = null;
    while ((m = re.exec(html)) !== null) {
        lastMatch = m[1];
    }
    if (!lastMatch) {
        throw new Error('Could not find compiled-project data in HTML. Is this an 02packager compiled-project HTML?');
    }
    const decoded = decodeURIComponent(lastMatch);
    return JSON.parse(decoded) as CompiledProjectData;
}

// ---------------------------------------------------------------------------
// Variable / list name resolution from target metadata
// ---------------------------------------------------------------------------

interface VarListNames {
    variableName: (id: string) => string;
    listName: (id: string) => string;
    isList: (id: string) => boolean;
    /** every id that names a list, for the decompiler's list-vs-scalar disambiguation */
    listIds: Set<string>;
}

/**
 * Build id -> name resolvers plus the list-id registry for a whole project.
 *
 * In SB3 a variable/list is declared on exactly one target (most often the Stage) yet can be
 * referenced from any script, and ids are globally unique. The registry must therefore be
 * built across *all* targets: a sprite that owns no lists still reads Stage-owned lists, and
 * the decompiler needs those ids to tell list ops from scalar ones.
 */
function buildVarListNames(projectJSON: any): VarListNames {
    const varMap = new Map<string, string>();
    const listMap = new Map<string, string>();
    const listIds = new Set<string>();

    for (const target of projectJSON?.targets || []) {
        for (const [id, entry] of Object.entries(target.variables || {})) {
            varMap.set(id, (entry as any[])[0]);
        }
        for (const [id, entry] of Object.entries(target.lists || {})) {
            listMap.set(id, (entry as any[])[0]);
            listIds.add(id);
        }
    }

    return {
        variableName: (id: string) => varMap.get(id) ?? id,
        listName: (id: string) => listMap.get(id) ?? id,
        isList: (id: string) => listIds.has(id),
        listIds,
    };
}

// ---------------------------------------------------------------------------
// Broadcast / key / backdrop case restoration
// ---------------------------------------------------------------------------

function collectBroadcastNames(projectJSON: any): Map<string, string> {
    const map = new Map<string, string>();
    for (const target of projectJSON.targets || []) {
        if (target.broadcasts) {
            for (const [name, id] of Object.entries(target.broadcasts)) {
                map.set(name.toUpperCase(), name);
            }
        }
    }
    return map;
}

function collectBackdropNames(projectJSON: any): Set<string> {
    const set = new Set<string>();
    const stage = (projectJSON.targets || []).find((t: any) => t.isStage);
    if (stage && stage.costumes) {
        for (const c of stage.costumes) {
            if (c.name) set.add(c.name);
        }
    }
    return set;
}

// ---------------------------------------------------------------------------
// Per-target decompilation + serialization
// ---------------------------------------------------------------------------

/**
 * Decompile all scripts + procedures of one target, serialize to SB3 blocks.
 * Returns the blocks map for this target.
 */
export interface RebuildResult {
    warnings: string[];
    /** number of targets whose blocks were successfully rebuilt from compiled data */
    rebuiltTargets: number;
}

/**
 * Rebuild every target's `blocks` map from compiled project data, mutating `projectJSON`.
 *
 * 02packager strips `blocks` out of the embedded project.json entirely (see
 * `cloneCompiledTargetSnapshot` in 02scratch-vm's virtual-machine.js -- it sets `blocks = {}`
 * and drops all comments except `// _twconfig_` ones). So the blocks have to be recovered
 * 100% from the compiled factory sources; anything the decompiler cannot recognise is lost.
 * That is why per-script failures are captured as warnings instead of thrown.
 */
export function rebuildProjectJSON(
    projectJSON: any,
    compiledProject: CompiledProjectData,
): RebuildResult {
    const warnings: string[] = [];
    const targets = projectJSON.targets || [];
    const compiledTargets = compiledProject.compiledTargets || {};
    let rebuiltTargets = 0;

    const broadcastNames = collectBroadcastNames(projectJSON);
    const backdropNames = collectBackdropNames(projectJSON);

    for (let i = 0; i < targets.length; i++) {
        const targetMeta = targets[i];
        // compiledTargets keys may be string indices or target names
        const key = String(i);
        const compiledTarget = compiledTargets[key] ?? compiledTargets[targetMeta.name] ?? compiledTargets[String(i)];
        if (!compiledTarget) {
            // Targets without compiled data (e.g., empty Stage) keep their original (empty) blocks.
            continue;
        }

        try {
            const blocks = decompileTarget(compiledTarget, targetMeta, projectJSON, warnings, broadcastNames, backdropNames);
            // Merge: only set blocks if we got non-empty results (empty targets keep original)
            if (Object.keys(blocks).length > 0) {
                targetMeta.blocks = blocks;
                rebuiltTargets++;
            }
        } catch (e: any) {
            warnings.push(`Target "${targetMeta.name}": decompilation error: ${e.message}`);
        }
    }

    return { warnings, rebuiltTargets };
}

/**
 * Structural signature of a stack: the opcode tree, ignoring every scalar input value.
 *
 * Used to recognise that a `scripts` entry is really a `procedures_definition`: 02scratch-vm
 * compiles every top-level block (including procedure definitions) into `scripts`, and for a
 * definition it substitutes each argument reporter with the prototype's default value. The
 * opcode tree is therefore identical to the real procedure body in `procedures` -- only the
 * input *values* differ -- so the tree signature matches them up.
 */
function stackSignature(stack: unknown): string {
    if (!(stack instanceof IntermediateStack)) return '';
    return stack.blocks.map(blockSignature).join(';');
}

function blockSignature(block: any): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(block.inputs || {})) {
        if (value instanceof IntermediateStack) parts.push(`${name}:${stackSignature(value)}`);
    }
    return `${block.opcode}(${parts.join(',')})`;
}

/**
 * Drop `scripts` entries that are just procedure definitions.
 *
 * `compileProjectFromJSON` (02scratch-vm) walks *all* top-level blocks, so a
 * `procedures_definition` ends up in `scripts` as well as in `procedures`. Serializing both
 * would emit every custom block twice, so the redundant script copy is removed and only the
 * real procedure (which keeps its argument reporters) is serialized as a definition.
 */
function dropProcedureDefinitionScripts(
    scripts: Record<string, any>,
    procedures: Record<string, any>,
    hatIds?: Set<string>,
): void {
    const taken = new Set<string>();
    const sigOf = (s: any) => (s ? stackSignature(s.stack) : '');

    // A definition's script copy is compiled with the prototype's argument *defaults* inlined.
    // Those defaults can change the generated code shape (e.g. 02scratch-vm drops a
    // `control_repeat` whose count folds to 0), so the copy may be shorter than the real
    // procedure body. Match exactly first, then fall back to "one is a prefix of the other".
    //
    // Hat scripts are excluded unconditionally: a hat is never a procedure definition, and the
    // prefix fallback could otherwise mistake a short hat script for a degraded body copy.
    const procSigs = [...Object.entries(procedures)].map(([variant, s]) => [variant, sigOf(s)] as const);
    const candidates = () => Object.keys(scripts).filter(id => !taken.has(id) && !hatIds?.has(id));

    // A procedure may only claim one script. The second pass must therefore skip procedures
    // that already matched, or a single procedure would delete two scripts (one exact match
    // plus one accidental prefix match) and silently drop a real script.
    const claimed = new Set<string>();

    for (const pass of ['exact', 'prefix'] as const) {
        for (const [variant, sig] of procSigs) {
            if (!sig || claimed.has(variant)) continue;
            for (const id of candidates()) {
                const sSig = sigOf(scripts[id]);
                if (!sSig) continue;
                const exact = sSig === sig;
                const prefix = sig.startsWith(sSig + ';') || sSig.startsWith(sig + ';');
                if (pass === 'exact' ? exact : prefix) {
                    delete scripts[id];
                    taken.add(id);
                    claimed.add(variant);
                    break;
                }
            }
        }
    }
}

/**
 * Strip the epilogue jsgen appends to every compiled script.
 *
 * `jsgen.stopScript()` runs unconditionally at the end of `compile()`, emitting
 * `retire(); return;` (or `return "";` for procedures). In IR that is a trailing
 * CONTROL_STOP_SCRIPT block (PROCEDURE_RETURN for procedures) that was never in the source
 * project, so leaving it in would put a stray "stop this script" / "return" at the end of every
 * rebuilt script. A *genuine* trailing block emits the same code *in addition* to the epilogue,
 * so removing exactly one trailing block keeps the real one and drops only the artifact.
 */
function dropScriptEpilogue(script: any): void {
    const blocks = script?.stack?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) return;
    const last = blocks[blocks.length - 1].opcode;
    if (last === StackOpcode.CONTROL_STOP_SCRIPT || last === StackOpcode.PROCEDURE_RETURN) {
        blocks.pop();
    }
}

function decompileTarget(
    compiledTarget: CompiledProjectData['compiledTargets'][string],
    targetMeta: any,
    projectJSON: any,
    warnings: string[],
    broadcastNames?: Map<string, string>,
    backdropNames?: Set<string>,
): Record<string, any> {
    const scripts: TargetIR['scripts'] = {};
    const procedures: TargetIR['procedures'] = {};
    const hats: HatData[] = [];

    // Collect hats metadata
    if (compiledTarget.hats) {
        for (const h of compiledTarget.hats) hats.push(h);
    }

    // Which variable ids name a *list*. jsgen emits byte-identical JS for several list vs
    // scalar pairs (LIST_LENGTH/OP_LENGTH, LIST_SHOW/VAR_SHOW, ...), so the decompiler can
    // only tell them apart with this registry. It must be threaded into every decompile call.
    const { listIds } = buildVarListNames(projectJSON);

    // Decompile procedures first (they may be referenced by scripts via linkSources)
    const procedureSources: Record<string, string> = {};
    if (compiledTarget.procedures) {
        for (const [variant, procData] of Object.entries(compiledTarget.procedures)) {
            if (procData.factorySource) {
                procedureSources[variant] = procData.factorySource;
            }
        }
    }

    // Decompile each script (per-script error isolation so one bad script doesn't kill the target)
    const scriptEntries = Object.entries(compiledTarget.scripts || {});

    for (const [topBlockId, scriptData] of scriptEntries) {
        if (!scriptData.factorySource) continue;

        try {
            const res = deobfuscateFactorySource(scriptData.factorySource);
            if (!res.factoryFound) {
                warnings.push(`Target "${targetMeta?.name}": script ${topBlockId}: factory not found (may be non-obfuscated)`);
            }
            const script = decompileScript(res.source, { listIds });
            dropScriptEpilogue(script);
            scripts[topBlockId] = script;
        } catch (e: any) {
            warnings.push(`Target "${targetMeta?.name}": script ${topBlockId}: ${e.message}`);
        }
    }

    // Decompile procedures
    for (const [variant, procSource] of Object.entries(procedureSources)) {
        try {
            const res = deobfuscateFactorySource(procSource);
            if (!res.factoryFound) {
                warnings.push(`Target "${targetMeta?.name}": procedure ${variant}: factory not found (may be non-obfuscated)`);
            }
            const script = decompileScript(res.source, { variant, listIds });
            dropScriptEpilogue(script);
            procedures[variant] = script;
        } catch (e: any) {
            warnings.push(`Target "${targetMeta?.name}": procedure ${variant}: ${e.message}`);
        }
    }

    dropProcedureDefinitionScripts(scripts, procedures, new Set(hats.map(h => h.topBlockId)));

    // Build serialize context
    const vl = buildVarListNames(projectJSON);
    const { info, argIds } = buildProcedureInfo(procedures);

    const ctx: SerializeContext = {
        variableName: vl.variableName,
        listName: vl.listName,
        isList: vl.isList,
        procedures: info,
        procedureArgIds: argIds,
        broadcastName: (u: string) => (broadcastNames ?? collectBroadcastNames(projectJSON)).get(u) ?? u,
        keyName: (u: string) => u.toLowerCase(),
        backdropName: (u: string) => {
            for (const name of backdropNames ?? collectBackdropNames(projectJSON)) {
                if (name.toUpperCase() === u.toUpperCase()) return name;
            }
            return u;
        },
    };

    const targetIR: TargetIR = { scripts, procedures, hats };
    const { blocks } = serializeTargetBlocks(targetIR, ctx);
    return blocks;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function unpackageHTML(htmlText: string): Promise<UnpackageResult> {
    const warnings: string[] = [];

    // 1. Check for 02engine compiled-project format
    const chunks = extractProjectChunks(htmlText);
    if (chunks.length === 0) {
        // 1b. Fall back to the plain (uncompiled) 02Engine embedding: the decoded
        // chunks are already a complete .sb3 zip (project.json keeps its blocks).
        const plainBytes = decodePlainArchive(extractPlainDataChunks(htmlText));
        if (plainBytes) {
            const JSZipPlain = JSZip ?? (await import('@turbowarp/jszip')).default;
            try {
                const plainZip = await JSZipPlain.loadAsync(plainBytes, { recoverCorrupted: true });
                const plainProjectFile = plainZip.file('project.json')
                    ?? (plainZip.file(/^([^/]*\/)?project\.json$/) || [])[0];
                if (!plainProjectFile) throw new Error('project.json not found');
                JSON.parse(await plainProjectFile.async('string')); // must be valid JSON
                return { sb3: plainBytes, warnings, mode: 'plain' };
            } catch {
                // Not a valid project zip → treat as unrecognized format below.
            }
        }
        throw new Error(
            'No 02engine project chunks found. This does not appear to be an 02packager ' +
            'compiled-project HTML or an 02Engine plain HTML.',
        );
    }

    // 2. Decode asset archive (zip with stripped project.json + assets)
    const archiveBytes = decodeProjectChunks(chunks);

    // 3. Extract compiled-project metadata
    const compiledProject = extractCompiledProjectData(htmlText);

    // 4. Load the asset archive zip
    const JSZipImpl = JSZip ?? (await import('@turbowarp/jszip')).default;
    const zip = await JSZipImpl.loadAsync(archiveBytes, { recoverCorrupted: true });

    // Find project.json
    let projectFile = zip.file('project.json');
    if (!projectFile) {
        const files = zip.file(/^([^/]*\/)?project\.json$/);
        projectFile = files[0];
    }
    if (!projectFile) {
        throw new Error('project.json not found in asset archive');
    }

    const projectJSON = JSON.parse(await projectFile.async('string'));

    // 5. Decompile each target's scripts + procedures, rebuild blocks
    const { warnings: rebuildWarnings } = rebuildProjectJSON(projectJSON, compiledProject);
    warnings.push(...rebuildWarnings);

    // 6. Write updated project.json back into the zip
    zip.file(projectFile.name, JSON.stringify(projectJSON));

    // 7. Generate .sb3
    const sb3 = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
    });

    return { sb3, warnings, mode: 'compiled' };
}
