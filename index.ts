/**
 * webmscore - TypeScript wrapper for the MuseScore 4.6.5 WASM build
 *
 * Converts MSCZ, MSCX, and MIDI files to MusicXML (and back to MSCZ).
 * Runs entirely in Node.js via WebAssembly; no native dependencies.
 *
 * @example
 * ```typescript
 * import { Score, StaffClefInfo, ready, load, version } from './index';
 * import * as fs from 'fs';
 *
 * await ready;
 * console.log('MuseScore format version:', version());
 *
 * const data = fs.readFileSync('myscore.mscz');
 * const score: Score = load('mscz', data);
 *
 * // Staff clef info — works for v2, v3, and v4 files
 * const clefs: StaffClefInfo[] = score.staffClefs();
 * console.log(clefs.map(s => `${s.partName}: ${s.clef}`).join(', '));
 * // e.g. "Piano: treble, Piano: bass"
 *
 * const xml: Buffer = score.saveXml();           // uncompressed MusicXML
 * const mxl: Buffer = score.saveMxl();           // compressed MusicXML
 * const mscz: Buffer = score.saveMsc();          // re-export as MSCZ
 * console.log(score.metadata());                 // title, composer, etc.
 * score.destroy();                               // free WASM memory
 * ```
 */

// Re-export the CJS module with full TypeScript types.
// Users of this package can import from this file (TypeScript source) or
// from webmscore.nodejs.cjs (CommonJS) with webmscore.d.ts for types.

import type { Score, StaffClefInfo, InputFormat, WebMscoreAPI } from './webmscore.d';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _WebMscore: WebMscoreAPI = require('./webmscore.nodejs.cjs');

/**
 * Promise that resolves when the WASM engine is fully initialized.
 * **Must be awaited before calling `load()`.**
 *
 * @example
 * await ready;
 */
export const ready: Promise<void> = _WebMscore.ready;

/**
 * Load a score file into the WASM engine.
 *
 * Supported input formats:
 * - `'mscz'`  — MuseScore 3/4 compressed archive (recommended)
 * - `'mscx'`  — MuseScore 3/4 uncompressed XML
 * - `'mid'` / `'midi'` — Standard MIDI file
 *
 * Legacy MuseScore 1/2 `.mscz` files (which wrap `.msc` XML) are also
 * supported via automatic ZIP extraction.
 *
 * @param format - One of `'mscz'`, `'mscx'`, `'mid'`, `'midi'`
 * @param data   - Raw file bytes as a `Buffer` or `Uint8Array`
 * @param doLayout - Run full score layout before export (default: `false`).
 *   Layout is not required for MusicXML export, and enabling it significantly
 *   slows down conversion. Only enable if you need pixel-accurate rendering data.
 * @returns A {@link Score} instance. **Call `.destroy()` when done** to release memory.
 * @throws `Error` if the file is corrupt, the format is unsupported, or WASM is not ready.
 *
 * @example
 * const data = fs.readFileSync('score.mscz');
 * const score = load('mscz', data);
 * const xml = score.saveXml();
 * score.destroy();
 */
export function load(
    format: InputFormat,
    data: Buffer | Uint8Array,
    doLayout = false
): Score {
    return _WebMscore.load(format, data, doLayout);
}

/**
 * Returns the MuseScore file format version this WASM build supports.
 * For MuseScore 4.6.x this is `460`.
 *
 * @example
 * console.log(version()); // 460
 */
export function version(): number {
    return _WebMscore.version();
}

/**
 * The full WebMscore API object (for advanced use).
 * Prefer importing `ready`, `load`, and `version` individually.
 */
export default _WebMscore;

// Re-export types for TypeScript consumers
export type { Score, StaffClefInfo, InputFormat, WebMscoreAPI };
