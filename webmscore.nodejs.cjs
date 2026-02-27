/**
 * webmscore.nodejs.cjs - Node.js CommonJS wrapper for MuseScore 4.6.5 WASM
 * 
 * Provides a high-level API for converting MSCZ/MIDI files to MusicXML.
 * Compatible with Node.js 18+ (tested with 22.x).
 * 
 * Usage:
 *   const WebMscore = require('./webmscore.nodejs.cjs');
 *   await WebMscore.ready;
 *   const score = await WebMscore.load('mscz', uint8Array);
 *   const xml = await score.saveXml();
 *   score.destroy();
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ARTIFACT_DIR = __dirname;

// Disable global fetch so Emscripten falls back to readBinary (fs.readFileSync)
// In Node.js 22+, global fetch exists but can't load local files via bare paths
if (typeof global.fetch !== 'undefined') {
    const _origFetch = global.fetch;
    global.fetch = function patchedFetch(url, opts) {
        const s = String(url);
        if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('blob:')) {
            return _origFetch(url, opts);
        }
        // For local files, reject so Emscripten uses readBinary instead
        return Promise.reject(new Error('Fetch disabled for local paths: ' + s));
    };
}

// Suppress IDBStore assertion (indexedDB not supported/needed in Node.js)
if (typeof global.indexedDB === 'undefined') {
    global.indexedDB = function() {};
}

// Window shim for Qt WASM code
try {
    if (typeof global.window === 'undefined') {
        Object.defineProperty(global, 'window', {
            value: { addEventListener() {}, location: new URL('file:///'), encodeURIComponent },
            writable: true, configurable: true
        });
    }
} catch(e) {}

// ----- Load the WASM module -----

let _Module = null;
let _initialized = false;

const _ready = new Promise((resolve, reject) => {
    // The lib.js file exports a factory function (CJS format)
    const libPath = path.join(ARTIFACT_DIR, 'webmscore.lib.js');
    
    let createModule;
    try {
        createModule = require(libPath);
    } catch(e) {
        reject(new Error('Failed to load webmscore.lib.js: ' + e.message));
        return;
    }

    createModule({
        // Resolve paths relative to this file's directory
        locateFile(name) {
            return path.join(ARTIFACT_DIR, name);
        },
        // Suppress verbose WASM logs
        print: () => {},
        printErr: (msg) => {
            if (msg && (msg.includes('ERROR') || msg.includes('WARN') || msg.includes('error') || msg.includes('assert'))) {
                // Only show real errors
                process.stderr.write('[webmscore] ' + msg.substring(0, 500) + '\n');
            }
        },
    }).then(mod => {
        _Module = mod;
        _initializeEngine();
        resolve();
    }).catch(reject);
});

/**
 * Initialize the MuseScore engine (called once after WASM loads).
 * Equivalent to calling init(argc, argv) in the C API.
 */
function _initializeEngine() {
    if (_initialized) return;
    _initialized = true;
    
    const argvPtr = _Module._malloc(4);
    const arg0Buf = _Module._malloc(16);
    _Module.stringToUTF8('webmscore', arg0Buf, 16);
    _Module.setValue(argvPtr, arg0Buf, 'i32');
    _Module.ccall('init', null, ['number', 'number'], [1, argvPtr]);
    _Module._free(argvPtr);
    _Module._free(arg0Buf);
}

/**
 * Clef name (from staffClefs()) → MusicXML inner content.
 * @private
 */
const _CLEF_TO_MUSICXML = {
    treble:           '<sign>G</sign><line>2</line>',
    treble8vb:        '<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>',
    treble15mb:       '<sign>G</sign><line>2</line><clef-octave-change>-2</clef-octave-change>',
    treble8va:        '<sign>G</sign><line>2</line><clef-octave-change>1</clef-octave-change>',
    treble15ma:       '<sign>G</sign><line>2</line><clef-octave-change>2</clef-octave-change>',
    bass:             '<sign>F</sign><line>4</line>',
    bass8vb:          '<sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change>',
    bass15mb:         '<sign>F</sign><line>4</line><clef-octave-change>-2</clef-octave-change>',
    bass8va:          '<sign>F</sign><line>4</line><clef-octave-change>1</clef-octave-change>',
    bass15ma:         '<sign>F</sign><line>4</line><clef-octave-change>2</clef-octave-change>',
    soprano:          '<sign>C</sign><line>1</line>',
    'mezzo-soprano':  '<sign>C</sign><line>2</line>',
    alto:             '<sign>C</sign><line>3</line>',
    tenor:            '<sign>C</sign><line>4</line>',
    baritone:         '<sign>C</sign><line>5</line>',
    baritone_b:       '<sign>F</sign><line>3</line>',
    varbaritone:      '<sign>F</sign><line>3</line>',
    percussion:       '<sign>percussion</sign>',
    tab:              '<sign>TAB</sign><line>5</line>',
    tab4:             '<sign>TAB</sign><line>5</line>',
};

/**
 * Inject missing <clef> elements into a MusicXML string using data from staffClefs().
 *
 * When saveXml() is called with doLayout=false (the default), MuseScore's exporter
 * omits <clef> elements from the first <attributes> block of each part.  MusicXML
 * renderers (OSMD, etc.) then default every staff to treble clef, so bass/alto staves
 * render incorrectly.
 *
 * This function reads the correct initial clef for each staff from `staffClefsData`
 * (the output of score.staffClefs()) and splices the missing <clef> elements in.
 * Parts that already contain a <clef> element are left untouched.
 *
 * @param {string} xml - MusicXML string from saveXml()
 * @param {Array<{staffIndex:number, partIndex:number, clef:string}>} staffClefsData
 * @returns {string} Patched MusicXML string
 */
function _injectMissingClefs(xml, staffClefsData) {
    if (!staffClefsData || staffClefsData.length === 0) return xml;

    // Group staves by partIndex, ordered by staffIndex within each part
    const partStaves = {};
    for (const sc of staffClefsData) {
        if (!partStaves[sc.partIndex]) partStaves[sc.partIndex] = [];
        partStaves[sc.partIndex].push(sc);
    }
    for (const arr of Object.values(partStaves)) {
        arr.sort((a, b) => a.staffIndex - b.staffIndex);
    }

    // Collect MusicXML part IDs in document order (P1, P2, … may not be sequential)
    const partIds = [];
    const partIdRx = /<part\s+id="([^"]+)"/g;
    let m;
    while ((m = partIdRx.exec(xml)) !== null) {
        if (!partIds.includes(m[1])) partIds.push(m[1]);
    }

    let result = xml;
    let offset = 0; // running offset due to insertions

    for (let order = 0; order < partIds.length; order++) {
        const partId = partIds[order];
        const staves = partStaves[order];
        if (!staves || staves.length === 0) continue;

        const searchFrom = offset;
        const partTag = `<part id="${partId}">`;
        const partStart = result.indexOf(partTag, searchFrom);
        if (partStart === -1) continue;

        const attrsStart = result.indexOf('<attributes>', partStart);
        if (attrsStart === -1) continue;

        const attrsEnd = result.indexOf('</attributes>', attrsStart);
        if (attrsEnd === -1) continue;

        const attrsBlock = result.substring(attrsStart, attrsEnd);

        // Skip: clef already present (doLayout=true path or mid-score change)
        if (attrsBlock.includes('<clef')) continue;

        // Build the clef XML to inject
        let injection = '';
        for (let i = 0; i < staves.length; i++) {
            const name = String(staves[i].clef).toLowerCase();
            const inner = _CLEF_TO_MUSICXML[name] || '<sign>G</sign><line>2</line>';
            const numAttr = staves.length > 1 ? ` number="${i + 1}"` : '';
            injection += `<clef${numAttr}>${inner}</clef>`;
        }

        // Insert before </attributes>
        result = result.substring(0, attrsEnd) + injection + result.substring(attrsEnd);
        offset = attrsEnd + injection.length; // next search starts after the injection
    }

    return result;
}

/**
 * Read a WasmRes struct returned by C API functions.
 * Format: [retCode:i32, dataSize:i32, data:bytes...]
 */
function _readWasmRes(ptr) {
    const retCode = _Module.getValue(ptr, 'i32');
    const dataSize = _Module.getValue(ptr + 4, 'i32');
    if (retCode !== 0) {
        const errMsg = _Module.UTF8ToString(ptr + 8, Math.min(dataSize, 1024));
        _Module._free(ptr);
        throw new Error(`WebMscore error ${retCode}: ${errMsg}`);
    }
    const data = Buffer.from(_Module.HEAPU8.buffer, ptr + 8, dataSize);
    const result = Buffer.from(data); // copy before freeing
    _Module._free(ptr);
    return result;
}

/**
 * Score instance - wraps a C++ MasterScore pointer.
 */
class Score {
    /**
     * @param {number} scorePtr - Pointer to C++ MasterScore
     */
    constructor(scorePtr) {
        this._ptr = scorePtr;
    }

    /**
     * Get the score title.
     * @returns {string}
     */
    title() {
        const ptr = _Module.ccall('title', 'number', ['number'], [this._ptr]);
        return _readWasmRes(ptr).toString('utf8');
    }

    /**
     * Export score as MusicXML (uncompressed .xml).
     * @param {number} [excerptId=-1] - Excerpt/part index, -1 for full score
     * @returns {Buffer} MusicXML content
     */
    saveXml(excerptId = -1) {
        const ptr = _Module.ccall('saveXml', 'number', ['number', 'number'], [this._ptr, excerptId]);
        return _readWasmRes(ptr);
    }

    /**
     * Export score as compressed MusicXML (.mxl).
     * @param {number} [excerptId=-1]
     * @returns {Buffer}
     */
    saveMxl(excerptId = -1) {
        const ptr = _Module.ccall('saveMxl', 'number', ['number', 'number'], [this._ptr, excerptId]);
        return _readWasmRes(ptr);
    }

    /**
     * Export score as MSCZ (compressed MuseScore format).
     * @param {boolean} [compressed=true]
     * @param {number} [excerptId=-1]
     * @returns {Buffer}
     */
    saveMsc(compressed = true, excerptId = -1) {
        const ptr = _Module.ccall('saveMsc', 'number', ['number', 'boolean', 'number'], [this._ptr, compressed, excerptId]);
        return _readWasmRes(ptr);
    }

    /**
     * Get score metadata as JSON.
     * @returns {Object}
     */
    metadata() {
        const ptr = _Module.ccall('saveMetadata', 'number', ['number'], [this._ptr]);
        const json = _readWasmRes(ptr).toString('utf8');
        try { return JSON.parse(json); } catch(e) { return {}; }
    }

    /**
     * Get staff clef information for all staves in the score.
     * Returns the default (initial) clef for each staff as read from the score model.
     *
     * This is more reliable than parsing MSCZ/MSCX source files because it
     * reads directly from the loaded MuseScore data model, works for all
     * file format versions (v2, v3, v4), and handles transposing instruments.
     *
     * @returns {Array<{staffIndex: number, partIndex: number, partName: string, clef: string, clefType: number}>}
     *   - staffIndex: 0-based index of the staff in the full score
     *   - partIndex:  0-based index of the part (instrument)
     *   - partName:   instrument/part name as stored in the file
     *   - clef:       human-readable clef name ('treble', 'bass', 'alto', 'tenor', 'soprano', 'percussion', etc.)
     *   - clefType:   raw ClefType integer (0=treble/G, 20=bass/F, etc.)
     */
    staffClefs() {
        const ptr = _Module.ccall('saveStaffClefs', 'number', ['number'], [this._ptr]);
        const json = _readWasmRes(ptr).toString('utf8');
        try { return JSON.parse(json); } catch(e) { return []; }
    }

    /**
     * Export score as a standard MIDI file (.mid).
     *
     * @param {boolean} [expandRepeats=true] - When true (default), repeat barlines
     *   and volta brackets are expanded so each repeated section appears only once.
     *   Pass false to export the score exactly as written (repeats NOT played back).
     * @returns {Buffer} Raw MIDI bytes (.mid format, Standard MIDI File Type 1)
     */
    saveMidi(expandRepeats = true) {
        const ptr = _Module.ccall('saveMidi', 'number', ['number', 'boolean'], [this._ptr, expandRepeats]);
        return _readWasmRes(ptr);
    }

    /**
     * Export score as MusicXML with clef elements guaranteed to be present.
     *
     * Calls saveXml() and then uses staffClefs() to inject <clef> elements into
     * the first <attributes> block of each part if they are missing (which happens
     * when doLayout=false, the default).  This is the recommended method for
     * producing MusicXML that renders correctly in OSMD and similar renderers.
     *
     * @param {number} [excerptId=-1] - Excerpt/part index, -1 for full score
     * @returns {Buffer} Patched MusicXML content (UTF-8)
     */
    saveXmlWithClefs(excerptId = -1) {
        const xml = this.saveXml(excerptId).toString('utf8');
        const clefs = this.staffClefs();
        return Buffer.from(_injectMissingClefs(xml, clefs), 'utf8');
    }

    /**
     * Free the score from memory.  Safe to call multiple times.
     */
    destroy() {
        if (!this._ptr) return; // already destroyed
        _Module.ccall('destroy', null, ['number'], [this._ptr]);
        this._ptr = 0;
    }
}

/**
 * WebMscore - main API object.
 * 
 * @example
 * const WebMscore = require('./webmscore.nodejs.cjs');
 * await WebMscore.ready;
 * const score = WebMscore.load('mscz', msczBuffer);
 * const xml = score.saveXml();
 * score.destroy();
 */
const WebMscore = {
    /**
     * Promise that resolves when the WASM module is fully loaded and initialized.
     * Await this before calling load().
     */
    ready: _ready,

    /**
     * Load a score file (MSCZ, MSCX, or MIDI).
     * 
     * The WASM must be initialized first: await WebMscore.ready
     * 
     * Signature is intentionally compatible with the browser webmscore.js API:
     *   load(format, data, fonts?, doLayout?)
     * The `fonts` parameter is accepted but ignored in Node.js.
     * 
     * @param {string} format - File format: 'mscz', 'mscx', 'mid', 'midi'
     * @param {Buffer|Uint8Array} data - File contents
     * @param {null|Array} [fonts] - Ignored (reserved for browser API compat)
     * @param {boolean} [doLayout=false] - Run score layout (slower, not needed for XML export)
     * @returns {Score} Score instance (call .destroy() when done)
     * @throws {Error} If loading fails (unsupported format, corrupt file, etc.)
     */
    load(format, data, fonts, doLayout) {
        if (!_Module) throw new Error('WebMscore not ready - await WebMscore.ready first');

        // Accept either (format, data, doLayout) or (format, data, fonts, doLayout)
        // for compatibility with browser webmscore.js (which has a fonts param).
        if (typeof fonts === 'boolean') {
            // Called as load(format, data, doLayout) — 3-arg form
            doLayout = fonts;
            fonts = null;
        }
        if (doLayout === undefined) doLayout = false;
        
        const fmt = format.toLowerCase().replace(/^\./, '');
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        const dp = _Module._malloc(buf.length);
        _Module.HEAPU8.set(buf, dp);
        
        try {
            const rp = _Module.ccall('load', 'number',
                ['string', 'number', 'number', 'number'],
                [fmt, dp, buf.length, doLayout ? 1 : 0]
            );
            const rd = _readWasmRes(rp);
            const scorePtr = rd.readUInt32LE(0);
            return new Score(scorePtr);
        } finally {
            _Module._free(dp);
        }
    },

    /**
     * Get the MuseScore format version number.
     * @returns {number}
     */
    version() {
        if (!_Module) return 0;
        return _Module.ccall('version', 'number', [], []);
    },
};

WebMscore.default = WebMscore; // workaround for import default handling
module.exports = WebMscore;
