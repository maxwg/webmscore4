# webmscore4

I needed a version of webmscore that would parse 4.0 mscz/mscx files.

I had AI butcher the repo in the process of updating musescore to 4.6.5, solely providing tests related to my use case:
* Converting mscz -> XML, XML -> MID

Consider these the only validated working scenarios

Note: another fork exists with musescore 4.3.2: https://github.com/CarlGao4/webmscore/tree/webmscore/web-public
However, the above fork failed at some conversions I required.

I leave only the artefacts of this conversion. I don't believe the repo to be humanly usable.

=============== BEWARE: NO HUMANS BEYOND THIS POINT =================

**MuseScore 4.6.5 score conversion, running in WebAssembly.**

Converts `.mscz`, `.mscx`, and `.mid` files to **MusicXML** in Node.js or the browser — no native dependencies, no MuseScore installation required.

---

## Features

- **Input formats**: MSCZ (MuseScore 2/3/4), MSCX, Standard MIDI (`.mid`)
- **Output formats**: MusicXML (`.xml`), Compressed MusicXML (`.mxl`), MIDI (`.mid`), MSCZ/MSCX round-trip
- **Repeat expansion**: `score.saveMidi(true)` automatically expands all repeat barlines and volta brackets
- **Clef extraction**: `score.staffClefs()` — reads treble/bass/alto/tenor/etc. directly from the score model, works for all file versions
- **Headless**: No display, GUI, or system fonts required — pure WASM
- **Browser + Node.js**: `webmscore.js` for browsers, `webmscore.nodejs.cjs` for Node.js
- **Fast**: ~10–500 ms per file; MIDI imports in milliseconds
- **Tested**: 40/40 test files pass across all supported formats (see [Test Coverage](#test-coverage))

---

## Package Contents

| File | Description |
|---|---|
| `webmscore.lib.wasm` | MuseScore engine (WebAssembly binary, ~11.8 MB / 4.6 MB gzip) |
| `webmscore.lib.js` | Emscripten JS loader for the WASM module |
| `webmscore.lib.data` | Bundled data: engraving styles, chord definitions, instruments (~390 KB) |
| `webmscore.nodejs.cjs` | Node.js CommonJS high-level API wrapper |
| `webmscore.js` | Browser high-level API wrapper (classic `<script>` tag) |
| `webmscore.d.ts` | TypeScript type declarations |
| `index.ts` | TypeScript source wrapper (for TypeScript projects) |

---

## Requirements

**Node.js**:
- Node.js 18+ (tested with v22.x)
- No other runtime dependencies

**Browser**:
- Any modern browser with WebAssembly support (Chrome 57+, Firefox 52+, Safari 11+, Edge 16+)
- All assets (`webmscore.lib.js`, `webmscore.lib.wasm`, `webmscore.lib.data`, `webmscore.js`) must be served from the same origin/directory

---

## Quick Start

### CommonJS

```javascript
const WebMscore = require('./webmscore.nodejs.cjs');
const fs = require('fs');

async function convert() {
    // Wait for WASM to initialize
    await WebMscore.ready;
    console.log('MuseScore format version:', WebMscore.version()); // 460

    // Load a score
    const data = fs.readFileSync('myscore.mscz');
    const score = WebMscore.load('mscz', data);

The quick-start examples above use `score.saveXml()`, which works for most purposes.
For correct clef rendering in any MusicXML renderer, prefer `score.saveXmlWithClefs()`.

> **⚠ Clef rendering warning:** Loading a score with `doLayout=false` (the default)
> causes MuseScore's MusicXML exporter to omit all `<clef>` elements from the first
> `<attributes>` block of each part.  Renderers like OSMD then default every staff to
> treble clef, so bass, alto, and other non-treble staves render incorrectly.
> Use `saveXmlWithClefs()` to avoid this.

    // Export to MusicXML
    const data = fs.readFileSync('myscore.mscz');
    const score = WebMscore.load('mscz', data);

    // Recommended: clefs always correct (inject if missing)
    const xml = score.saveXmlWithClefs();
    fs.writeFileSync('output.musicxml', xml);

    // Always free memory when done
    score.destroy();
}

convert().catch(console.error);
```

### Browser

Include `webmscore.js` as a classic script tag. All sibling assets
(`webmscore.lib.js`, `webmscore.lib.wasm`, `webmscore.lib.data`) must be
served from the same directory.

```html
<!-- Serve all webmscore files from the same directory -->
<script src="/assets/webmscore.js"></script>
<script>
  WebMscore.ready.then(function () {
    return fetch('/scores/myscore.mscz');
  })
  .then(function (res) { return res.arrayBuffer(); })
  .then(function (buf) {
    return WebMscore.load('mscz', new Uint8Array(buf));
  })
  .then(function (score) {
    return score.saveXmlWithClefs().then(function (xml) {
      console.log('MusicXML length:', xml.length);
      // pass xml to OSMD, Vexflow, or another renderer
      score.destroy();
    });
  })
  .catch(console.error);
</script>
```

To override the base URL (e.g. when the script tag URL doesn't contain
"webmscore"), set `window.MSCORE_SCRIPT_URL` before loading the script:

```html
<script>window.MSCORE_SCRIPT_URL = '/cdn/musescore/';</script>
<script src="/cdn/musescore/webmscore.js"></script>
```

### TypeScript

```typescript
import { ready, load, version } from './index';
import * as fs from 'fs';

await ready;
console.log('Format version:', version()); // 460

const data = fs.readFileSync('myscore.mscz');
const score = load('mscz', data);

const xml: Buffer = score.saveXml();
fs.writeFileSync('output.musicxml', xml);

score.destroy();
```

---

## API Reference

### `WebMscore.ready`

```typescript
ready: Promise<void>
```

Promise that resolves when the WASM engine has fully loaded. You **must** await this before calling `load()`.

---

### `WebMscore.load(format, data, doLayout?)`

```typescript
load(format: 'mscz' | 'mscx' | 'mid' | 'midi',
     data: Buffer | Uint8Array,
     doLayout?: boolean): Score
```

Loads a score into the engine and returns a `Score` object.

| Parameter | Type | Description |
|---|---|---|
| `format` | `string` | File format: `'mscz'`, `'mscx'`, `'mid'`, or `'midi'` |
| `data` | `Buffer \| Uint8Array` | Raw file bytes |
| `doLayout` | `boolean` | Run full layout (default: `false`). Not needed for XML export. |

Returns a [`Score`](#score-methods) instance. **Call `.destroy()` when done.**

Throws `Error` if the file is corrupt, unrecognized, or WASM is not ready.

---

### `WebMscore.version()`

```typescript
version(): number
```

Returns the MuseScore file format version: `460` (for MuseScore 4.6.x).

---

### Score Methods

#### `score.title()`
```typescript
title(): string
```
Returns the score title. May be empty for untitled scores.

---

#### `score.saveXml(excerptId?)`
```typescript
saveXml(excerptId?: number): Buffer
```
Exports the score as **uncompressed MusicXML** (`.xml`).

- `excerptId = -1` (default): full score
- `excerptId >= 0`: export a specific part/excerpt by index

Returns a `Buffer` containing the XML text.

> **Note:** When loaded with `doLayout=false` (the default), the output will not
> contain `<clef>` elements.  Use `saveXmlWithClefs()` for renderer-safe output.

---

#### `score.saveXmlWithClefs(excerptId?)` ⭐ recommended
```typescript
saveXmlWithClefs(excerptId?: number): Buffer         // Node.js (sync)
saveXmlWithClefs(excerptId?: number): Promise<string> // Browser (async)
```
Exports the score as **MusicXML with clef elements guaranteed to be present.**

This is the recommended method for producing MusicXML that will be rendered (e.g.
in OSMD, Vexflow, or any other renderer).

Under the hood it combines `saveXml()` with `staffClefs()`:
1. Exports the raw MusicXML
2. Reads the correct initial clef for every staff from the MuseScore data model
3. Injects `<clef>` elements into each `<part>` that is missing them

If the MusicXML already contains `<clef>` elements (e.g. because `doLayout=true`
was used), the output is returned unchanged.

```javascript
// Node.js
const xml = score.saveXmlWithClefs();
fs.writeFileSync('output.musicxml', xml);

// Browser
const xml = await score.saveXmlWithClefs();
osmd.load(xml);
```

---

#### `score.saveMxl(excerptId?)`
```typescript
saveMxl(excerptId?: number): Buffer
```
Exports the score as **compressed MusicXML** (`.mxl`). MXL is a ZIP archive containing the MusicXML file plus `META-INF/container.xml`.

---

#### `score.saveMidi(expandRepeats?)`
```typescript
saveMidi(expandRepeats?: boolean): Buffer          // Node.js (sync)
saveMidi(expandRepeats?: boolean): Promise<Uint8Array>  // Browser (async)
```
Exports the score as a **standard MIDI file** (`.mid`, Type 1).

| Parameter | Default | Description |
|---|---|---|
| `expandRepeats` | `true` | Expand repeat barlines and volta brackets so each repeated section appears once in the MIDI. Pass `false` to export the score exactly as written. |

```javascript
// Node.js — with repeat expansion (default)
const midi = score.saveMidi();
fs.writeFileSync('output.mid', midi);

// Node.js — without repeat expansion
const midiRaw = score.saveMidi(false);

// Browser
const midiBytes = await score.saveMidi();
```

This uses MuseScore's built-in MIDI renderer. Output quality matches what MuseScore
produces when exporting to MIDI natively (including articulations, dynamics, and
tempo markings).

---

#### `score.saveMsc(compressed?, excerptId?)`
```typescript
saveMsc(compressed?: boolean, excerptId?: number): Buffer
```
Re-exports the score in MuseScore's native format.

- `compressed = true` (default): produces `.mscz` (ZIP archive)
- `compressed = false`: produces `.mscs` / `.mscx` (plain XML)

---

#### `score.metadata()`
```typescript
metadata(): Record<string, unknown>
```
Returns score metadata as a plain object. Common fields:

```json
{
  "title": "Clair de Lune",
  "composer": "Claude Debussy",
  "mscVersion": "4.50",
  "creationDate": "2024-01-15"
}
```

---

#### `score.staffClefs()`
```typescript
staffClefs(): StaffClefInfo[]   // Node.js (synchronous)
staffClefs(): Promise<StaffClefInfo[]>  // Browser (async)
```

Returns the default clef for every staff in the score, in staff order.

Each entry is a `StaffClefInfo` object:
```typescript
{
    staffIndex: number;  // 0-based staff index in the full score
    partIndex:  number;  // 0-based part (instrument) index
    partName:   string;  // instrument name, e.g. "Piano", "Violin"
    clef:       string;  // human-readable clef: 'treble', 'bass', 'alto', etc.
    clefType:   number;  // raw ClefType int: 0=treble, 20=bass, 10=alto, ...
}
```

Common clef values:

| `clef` | Typical instrument |
|---|---|
| `treble` | Piano RH, Violin, Flute, Voice |
| `bass` | Piano LH, Cello, Bass |
| `alto` | Viola |
| `tenor` | Cello (upper register), Tenor trombone |
| `treble8vb` | Guitar (sounds 8vb), Tenor voice |
| `bass8vb` | Contrabass, Contrabassoon |
| `percussion` | Drums, unpitched percussion |
| `soprano` | Soprano voice (historical) |

```javascript
const clefs = score.staffClefs();
// Example for a piano score:
// [
//   { staffIndex: 0, partIndex: 0, partName: 'Piano', clef: 'treble', clefType: 0 },
//   { staffIndex: 1, partIndex: 0, partName: 'Piano', clef: 'bass',   clefType: 20 }
// ]

const isGrandStaff = clefs.length === 2
    && clefs[0].clef === 'treble'
    && clefs[1].clef === 'bass';
```

**Why this method exists**: Parsing clef data from raw `.mscz` / `.mscx` files
is unreliable across format versions. MuseScore 4.x uses `<Part id="N">` in
the XML while v2/v3 use `<Part>`, breaking naive regex approaches. This API
reads directly from the loaded score model, working correctly for all versions.
See [clef-report.md](../clef-report.md) for the full investigation.

---

#### `score.destroy()`
```typescript
destroy(): void
```
Frees the score from WASM heap memory. **Always call this when you are done with a score.** Safe to call multiple times.

```javascript
const score = WebMscore.load('mscz', data);
try {
    const xml = score.saveXml();
    // use xml...
} finally {
    score.destroy(); // always free memory
}
```

---

## Supported Input Formats

| Format | Extension | Notes |
|---|---|---|
| MSCZ | `.mscz` | MuseScore 2, 3, and 4 (recommended) |
| MSCX | `.mscx` | MuseScore 3/4 uncompressed XML |
| MIDI | `.mid`, `.midi` | Standard MIDI format; tempo and time signature are preserved |

### Legacy MuseScore Files

MuseScore 1.x files used `.mscz` as a ZIP archive containing a `.msc` XML (not `.mscx`). These are automatically detected and handled — no special handling required.

---

## Memory Management

The WASM module uses a fixed heap (64 MB). Each loaded score consumes heap memory until `score.destroy()` is called. In long-running processes, always destroy scores you no longer need.

Multiple scores can be loaded simultaneously (up to memory limits):

```javascript
await WebMscore.ready;

const files = ['a.mscz', 'b.mscz', 'c.mid'];
const results = [];

for (const file of files) {
    const data = fs.readFileSync(file);
    const ext = file.split('.').pop();
    const score = WebMscore.load(ext, data);
    results.push({ file, xml: score.saveXml() });
    score.destroy(); // free before loading next
}
```

---

## Test Coverage

All 40 test files pass. Tests run against the MuseScore build (MuseScore 4.6.5, format version 460).

| File | Format | Title | Status |
|---|---|---|---|
| VHard.mscz | MSCZ | Untitled score | ✅ PASS |
| AOM.mscz | MSCZ | All Of Me | ✅ PASS |
| accidental3.mscz | MSCZ | Untitled | ✅ PASS |
| arpeggio.mscz | MSCZ | Untitled | ✅ PASS |
| atw.mscz | MSCZ | All Too Well | ✅ PASS |
| cdl.mscz | MSCZ | Clair de Lune | ✅ PASS |
| chordlist.mscx | MSCX | Untitled | ✅ PASS |
| crossbeams.mscx | MSCX | Untitled | ✅ PASS |
| etude6.mscz | MSCZ | 6. A Minor | ✅ PASS |
| fractional_beams.mscz | MSCZ (legacy) | Untitled | ✅ PASS |
| harmony.mscx | MSCX | Chord test | ✅ PASS |
| mmrest.mscz | MSCZ | Untitled | ✅ PASS |
| mrgl.mscz | MSCZ | Untitled | ✅ PASS |
| noteheads.mscz | MSCZ | Untitled | ✅ PASS |
| opal.mscz | MSCZ | Opalite | ✅ PASS |
| piccolo.mscz | MSCZ | Untitled | ✅ PASS |
| preludec.mscz | MSCZ | Untitled | ✅ PASS |
| repeat-s1.mscz | MSCZ | Untitled | ✅ PASS |
| repeat-s2.mscz | MSCZ | Untitled | ✅ PASS |
| repeat-u.mscz | MSCZ | Untitled | ✅ PASS |
| slur1.mscx | MSCX | Slur-Test | ✅ PASS |
| slur3.mscz | MSCZ | Untitled | ✅ PASS |
| stafftest.mscx | MSCX | stafftest | ✅ PASS |
| tab.mscx | MSCX | Untitled | ✅ PASS |
| test3.mscx | MSCX | Untitled | ✅ PASS |
| testsmall.mscx | MSCX | Untitled | ✅ PASS |
| articulation.mscx | MSCX | Untitled | ✅ PASS |
| beam1.mscx | MSCX | Beam-Test | ✅ PASS |
| MIDI1.MID | MIDI | Untitled | ✅ PASS |
| POTC.mid | MIDI | Untitled | ✅ PASS |
| RUN.mid | MIDI | Untitled | ✅ PASS |
| midi/midi1.mid | MIDI | Untitled | ✅ PASS |
| midi/midi2.mid | MIDI | Untitled | ✅ PASS |
| midi/midi3.mid | MIDI | Untitled | ✅ PASS |
| midi/midi4.mid | MIDI | Untitled | ✅ PASS |
| midi/midi5.mid | MIDI | Untitled | ✅ PASS |
| midi/midi10.mid | MIDI | Untitled | ✅ PASS |
| ntest/slur.mscx | MSCX | tie | ✅ PASS |
| ntest/stem-1.mscx | MSCX | stem-1 | ✅ PASS |
| ntest/tie.mscx | MSCX | tie | ✅ PASS |

**Total: 40/40 passed**

---

## Bundle Size

| File | Raw | Gzip |
|---|---|---|
| `webmscore.lib.wasm` | 11.84 MB | 4.55 MB |
| `webmscore.lib.data` | 389 KB | ~130 KB |
| `webmscore.lib.js` | 261 KB | ~80 KB |
| `webmscore.nodejs.cjs` | 8 KB | — |

The `.wasm` file contains the full MuseScore engraving engine, all music fonts (Leland, Edwin, MScore, etc.) and MIDI import support compiled in via Qt QRC resources.

---

## Build Information

| Component | Version |
|---|---|
| MuseScore | 4.6.5 |
| File format | 460 |
| Emscripten | emsdk latest |
| Qt | 6.5.3 (wasm_singlethread) |
| Optimization | `-Oz -flto` + `wasm-opt -Oz` |
| WASM memory | 64 MB initial, `emmalloc` |

---

## License

GNU GPL v3 — same as MuseScore Studio.
See [LICENSE.txt](../LICENSE.txt) for full terms.
