/**
 * webmscore.d.ts — TypeScript type declarations for webmscore.nodejs.cjs
 *
 * Usage (CommonJS):
 *   const WebMscore = require('./webmscore.nodejs.cjs');
 *   await WebMscore.ready;
 *   const score = WebMscore.load('mscz', data);
 *
 * Usage (TypeScript / ESM with index.ts):
 *   import { ready, load, version } from './index';
 */

/// <reference types="node" />

/**
 * Information about the default clef of one staff in the score.
 * Returned by {@link Score.staffClefs}.
 */
export interface StaffClefInfo {
    /** 0-based index of this staff within the full score. */
    staffIndex: number;
    /** 0-based index of the part (instrument) this staff belongs to. */
    partIndex: number;
    /** Instrument/part name as stored in the score file (e.g. `"Piano"`, `"Violin"`). */
    partName: string;
    /**
     * Human-readable clef name.
     * Common values: `'treble'`, `'bass'`, `'alto'`, `'tenor'`, `'soprano'`,
     * `'mezzo-soprano'`, `'baritone'`, `'percussion'`, `'treble8vb'`, etc.
     */
    clef: string;
    /**
     * Raw MuseScore `ClefType` integer.
     * Key values: `0` = treble (G clef), `20` = bass (F clef).
     * See the C++ `engraving::ClefType` enum for the full list.
     */
    clefType: number;
}

/**
 * A loaded score object. Wraps a C++ `MasterScore` pointer inside the WASM module.
 *
 * **Memory management**: Always call `.destroy()` when you are done with the score.
 * Failing to do so leaks WASM heap memory; WASM memory cannot be garbage-collected.
 */
export interface Score {
    /**
     * Returns the score title as stored in the file.
     * May be empty string for untitled scores.
     */
    title(): string;

    /**
     * Exports the score (or a single excerpt/part) as uncompressed MusicXML.
     *
     * @param excerptId - Part/excerpt index. Use `-1` (default) for the full score.
     *   Parts start at `0`. An excerpt is a subset of instruments extracted from
     *   the main score. Most files only have a full score (index -1).
     * @returns Raw MusicXML bytes as a Node.js `Buffer`.
     *
     * @example
     * const xml = score.saveXml();
     * fs.writeFileSync('output.musicxml', xml);
     */
    saveXml(excerptId?: number): Buffer;

    /**
     * Exports the score as a standard MIDI file (`.mid`).
     *
     * Uses the legacy MuseScore MIDI renderer (`CompatMidiRendererInternal`),
     * which does not require the audio/MPE module.
     *
     * @param expandRepeats - When `true` (default), repeat barlines and volta
     *   brackets are expanded: each section marked with a repeat is played the
     *   correct number of times in the output.  Pass `false` to export the score
     *   exactly as written on the page without expanding any repeats.
     * @returns Raw MIDI bytes in Standard MIDI File Type 1 format.
     */
    saveMidi(expandRepeats?: boolean): Buffer;

    /**
     * Exports the score as compressed MusicXML (`.mxl` format).
     * MXL is a ZIP file containing the MusicXML plus a `META-INF/container.xml`.
     *
     * @param excerptId - Part/excerpt index (-1 = full score).
     * @returns Compressed MusicXML bytes (ZIP).
     */
    saveMxl(excerptId?: number): Buffer;

    /**
     * Re-exports the score in MuseScore's native format (`.mscz` or `.mscs`).
     *
     * @param compressed - Use zip compression (`.mscz`). Default: `true`.
     *   Pass `false` for uncompressed XML (`.mscs` / `.mscx`).
     * @param excerptId - Part/excerpt index (-1 = full score).
     * @returns MSCZ (zip) or MSCS (XML) bytes.
     */
    saveMsc(compressed?: boolean, excerptId?: number): Buffer;

    /**
     * Returns the score's metadata as a plain JavaScript object.
     *
     * Common fields include:
     * - `title`: score title
     * - `subtitle`: subtitle
     * - `composer`: composer name
     * - `arranger`: arranger name
     * - `workNumber`: opus/catalogue number
     * - `mscVersion`: MuseScore file format version string
     * - `creationDate`: ISO date string
     * - `platform`: software platform used to create the file
     *
     * The exact fields depend on what the score author filled in.
     */
    metadata(): Record<string, unknown>;

    /**
     * Returns the default clef for every staff in the score.
     *
     * Reads directly from the MuseScore data model (not from the raw file bytes),
     * so it works correctly for ALL file format versions (v2, v3, v4 — including
     * the v4.x `<Part id="N">` format that defeats naive XML regex approaches).
     *
     * @returns Array of staff clef entries, one per staff in score order.
     *
     * @example
     * const clefs = score.staffClefs();
     * // e.g. [
     * //   { staffIndex: 0, partIndex: 0, partName: 'Piano', clef: 'treble', clefType: 0 },
     * //   { staffIndex: 1, partIndex: 0, partName: 'Piano', clef: 'bass',   clefType: 20 }
     * // ]
     * console.log(clefs.map(s => s.clef).join(', ')); // "treble, bass"
     */
    staffClefs(): StaffClefInfo[];

    /**
     * Exports the score as MusicXML with clef elements guaranteed to be present.
     *
     * When a score is loaded with `doLayout=false` (the default), MuseScore's
     * MusicXML exporter **omits `<clef>` elements** from the first `<attributes>`
     * block of each part.  MusicXML renderers such as OSMD then default every
     * staff to treble clef, causing bass, alto, and other non-treble staves to
     * render incorrectly.
     *
     * This method calls `saveXml()` then uses `staffClefs()` to inject the
     * correct `<clef>` element for every part that is missing one.  Parts
     * that already have a `<clef>` element (e.g. when `doLayout=true` was used)
     * are left untouched.
     *
     * **Use this instead of `saveXml()` whenever the output will be rendered.**
     *
     * @param excerptId - Part/excerpt index (-1 = full score, default).
     * @returns Patched MusicXML as a UTF-8 `Buffer`.
     *
     * @example
     * const xml = score.saveXmlWithClefs();
     * fs.writeFileSync('output.musicxml', xml);
     */
    saveXmlWithClefs(excerptId?: number): Buffer;

    /**
     * Frees the score from WASM heap memory.
     *
     * Safe to call multiple times — subsequent calls after the first are no-ops.
     * Always call `destroy()` when you are finished with the score to avoid
     * memory leaks in long-running processes.
     *
     * @example
     * const score = WebMscore.load('mscz', data);
     * try {
     *   const xml = score.saveXmlWithClefs();
     *   // ... use xml ...
     * } finally {
     *   score.destroy(); // always free memory
     * }
     */
    destroy(): void;
}

/**
 * Supported input file formats.
 *
 * - `'mscz'`  — MuseScore compressed archive (MuseScore 2, 3, or 4)
 * - `'mscx'`  — MuseScore uncompressed XML (MuseScore 3 or 4)
 * - `'mid'`   — Standard MIDI file (`.mid` / `.midi`)
 * - `'midi'`  — Alias for `'mid'`
 *
 * Note: Legacy MuseScore 1/2 `.mscz` files that contain `.msc` XML inside
 * the ZIP archive are detected and handled automatically.
 */
export type InputFormat = 'mscz' | 'mscx' | 'mid' | 'midi';

/**
 * The WebMscore API object exported by `webmscore.nodejs.cjs`.
 */
export interface WebMscoreAPI {
    /**
     * A Promise that resolves when the WASM engine has finished initializing.
     * **You must await this before calling `load()`.**
     *
     * @example
     * const WebMscore = require('./webmscore.nodejs.cjs');
     * await WebMscore.ready;
     * // safe to call load() now
     */
    ready: Promise<void>;

    /**
     * Load a score from raw file bytes.
     *
     * Signature is intentionally compatible with the browser `webmscore.js` API —
     * both accept `(format, data, fonts?, doLayout?)` where `fonts` is reserved and
     * should be `null`.  Passing `(format, data, doLayout)` (3-arg form) also works.
     *
     * Supported formats: `'mscz'`, `'mscx'`, `'mid'`, `'midi'`.
     * Legacy MuseScore 1/2 `.mscz` files are also handled transparently.
     *
     * @param format  - The file format. Case-insensitive; leading dots are stripped.
     * @param data    - Raw file bytes (`Buffer` or `Uint8Array`).
     * @param fonts   - Reserved for browser API compatibility. Pass `null` or omit.
     * @param doLayout - Run full score layout before export. Default: `false`.
     *   Not required for MusicXML conversion; enabling it is significantly slower.
     * @returns A {@link Score} object. Call `.destroy()` when done.
     * @throws {Error} On corrupt/unrecognized files, or if WASM is not initialized.
     */
    load(format: InputFormat, data: Buffer | Uint8Array, fonts?: null | never[], doLayout?: boolean): Score;

    /**
     * Returns the MuseScore file format version supported by this WASM build.
     * For MuseScore 4.6.x this returns `460`.
     */
    version(): number;

    /** CJS / ESM interop alias — same as the module itself. */
    default: WebMscoreAPI;
}

declare const WebMscore: WebMscoreAPI;
export default WebMscore;
