/**
 * webmscore.js — High-level browser wrapper for the MuseScore 4.6.5 WASM build
 *
 * Bridges webmscore.lib.js (Emscripten factory) → window.WebMscore API
 * compatible with ConversionService and similar browser consumers.
 *
 * Loaded as a classic <script> tag before any code that uses window.WebMscore.
 *
 * Usage:
 *   <script src="webmscore.js"></script>
 *   <script>
 *     WebMscore.ready.then(async () => {
 *       const response = await fetch('score.mscz');
 *       const data = new Uint8Array(await response.arrayBuffer());
 *       const score = await WebMscore.load('mscz', data);
 *       const xml = await score.saveXml();
 *       const clefs = await score.staffClefs();
 *       score.destroy();
 *     });
 *   </script>
 */
(function () {
  'use strict';

  // Determine base URL for sibling assets (.wasm, .data, .lib.js)
  var basePath = (window.MSCORE_SCRIPT_URL || '').replace(/\/?$/, '/');

  if (!basePath || basePath === '/') {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('webmscore') !== -1) {
          basePath = scripts[i].src.replace(/\/[^/]*$/, '/');
          break;
        }
      }
    } catch (_) { /* noop */ }
  }

  var modulePromise = null;

  function getTypedArrayPtr(Module, data) {
    var size = data.length * data.BYTES_PER_ELEMENT;
    var ptr = Module._malloc(size);
    Module.HEAPU8.set(data, ptr);
    return ptr;
  }

  // ---- WasmRes helpers ----

  function WasmRes(Module, ptr) {
    this._module = Module;
    this._ptr = ptr;
    this._size = WasmRes._getUint32(Module, ptr + 4);
    this._checkRet();
  }

  WasmRes._getUint32 = function (Module, ptr) {
    var view = new DataView(Module.HEAPU8.buffer, ptr, 4);
    return view.getUint32(0, true);
  };

  WasmRes.prototype._checkRet = function () {
    var retCode = WasmRes._getUint32(this._module, this._ptr);
    if (retCode !== 0) {
      var message = this.text();
      this.free();
      throw new Error('WebMscore error ' + retCode + ': ' + message);
    }
  };

  WasmRes.prototype.data = function () {
    var start = this._ptr + 8;
    return new Uint8Array(this._module.HEAPU8.subarray(start, start + this._size));
  };

  WasmRes.prototype.text = function () {
    return this._module.UTF8ToString(this._ptr + 8, this._size);
  };

  WasmRes.prototype.number = function () {
    return WasmRes._getUint32(this._module, this._ptr + 8);
  };

  WasmRes.prototype.free = function () {
    this._module._free(this._ptr);
  };

  WasmRes.readText = function (Module, ptr) {
    var res = new WasmRes(Module, ptr);
    var value = res.text();
    res.free();
    return value;
  };

  WasmRes.readNum = function (Module, ptr) {
    var res = new WasmRes(Module, ptr);
    var value = res.number();
    res.free();
    return value;
  };

  WasmRes.readData = function (Module, ptr) {
    var res = new WasmRes(Module, ptr);
    var value = res.data();
    res.free();
    return value;
  };

  // ---- Clef injection utility ----

  /**
   * Mapping from staffClefs() clef name → MusicXML inner content.
   * @private
   */
  var CLEF_TO_MUSICXML = {
    treble:          '<sign>G</sign><line>2</line>',
    treble8vb:       '<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>',
    treble15mb:      '<sign>G</sign><line>2</line><clef-octave-change>-2</clef-octave-change>',
    treble8va:       '<sign>G</sign><line>2</line><clef-octave-change>1</clef-octave-change>',
    treble15ma:      '<sign>G</sign><line>2</line><clef-octave-change>2</clef-octave-change>',
    bass:            '<sign>F</sign><line>4</line>',
    bass8vb:         '<sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change>',
    bass15mb:        '<sign>F</sign><line>4</line><clef-octave-change>-2</clef-octave-change>',
    bass8va:         '<sign>F</sign><line>4</line><clef-octave-change>1</clef-octave-change>',
    bass15ma:        '<sign>F</sign><line>4</line><clef-octave-change>2</clef-octave-change>',
    soprano:         '<sign>C</sign><line>1</line>',
    'mezzo-soprano': '<sign>C</sign><line>2</line>',
    alto:            '<sign>C</sign><line>3</line>',
    tenor:           '<sign>C</sign><line>4</line>',
    baritone:        '<sign>C</sign><line>5</line>',
    baritone_b:      '<sign>F</sign><line>3</line>',
    varbaritone:     '<sign>F</sign><line>3</line>',
    percussion:      '<sign>percussion</sign>',
    tab:             '<sign>TAB</sign><line>5</line>',
    tab4:            '<sign>TAB</sign><line>5</line>'
  };

  /**
   * Inject missing <clef> elements into a MusicXML string.
   *
   * When saveXml() is called without doLayout=true, MuseScore's exporter omits
   * <clef> from the first <attributes> block so renderers default all staves to
   * treble.  This function uses the data returned by staffClefs() to splice in
   * the correct clef for each part.  Parts that already carry a <clef> element
   * are left untouched.
   *
   * @param {string} xml
   * @param {Array<{staffIndex:number,partIndex:number,clef:string}>} staffClefsData
   * @returns {string}
   * @private
   */
  function injectMissingClefs(xml, staffClefsData) {
    if (!staffClefsData || staffClefsData.length === 0) return xml;

    // Group staves by partIndex, ordered by staffIndex
    var partStaves = {};
    for (var i = 0; i < staffClefsData.length; i++) {
      var sc = staffClefsData[i];
      if (!partStaves[sc.partIndex]) partStaves[sc.partIndex] = [];
      partStaves[sc.partIndex].push(sc);
    }
    var pKeys = Object.keys(partStaves);
    for (var k = 0; k < pKeys.length; k++) {
      partStaves[pKeys[k]].sort(function (a, b) { return a.staffIndex - b.staffIndex; });
    }

    // Collect <part id="..."> in document order
    var partIds = [];
    var partIdRx = /<part\s+id="([^"]+)"/g;
    var m;
    while ((m = partIdRx.exec(xml)) !== null) {
      if (partIds.indexOf(m[1]) === -1) partIds.push(m[1]);
    }

    var result = xml;
    var offset = 0;

    for (var order = 0; order < partIds.length; order++) {
      var partId = partIds[order];
      var staves = partStaves[order];
      if (!staves || staves.length === 0) continue;

      var partTag = '<part id="' + partId + '">';
      var partStart = result.indexOf(partTag, offset);
      if (partStart === -1) continue;

      var attrsStart = result.indexOf('<attributes>', partStart);
      if (attrsStart === -1) continue;

      var attrsEnd = result.indexOf('</attributes>', attrsStart);
      if (attrsEnd === -1) continue;

      var attrsBlock = result.substring(attrsStart, attrsEnd);
      if (attrsBlock.indexOf('<clef') !== -1) continue; // already present

      var injection = '';
      for (var j = 0; j < staves.length; j++) {
        var name = String(staves[j].clef).toLowerCase();
        var inner = CLEF_TO_MUSICXML[name] || '<sign>G</sign><line>2</line>';
        var numAttr = staves.length > 1 ? ' number="' + (j + 1) + '"' : '';
        injection += '<clef' + numAttr + '>' + inner + '</clef>';
      }

      result = result.substring(0, attrsEnd) + injection + result.substring(attrsEnd);
      offset = attrsEnd + injection.length;
    }

    return result;
  }

  // ---- Score object ----

  function Score(Module, scorePtr) {
    this._module = Module;
    this._ptr = scorePtr;
  }

  /**
   * Export score as uncompressed MusicXML string.
   * @param {number} [excerptId=-1] - Part index, -1 for full score
   * @returns {Promise<string>}
   */
  Score.prototype.saveXml = function (excerptId) {
    if (excerptId === undefined) excerptId = -1;
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('saveXml', 'number', ['number', 'number'], [scorePtr, excerptId]);
        resolve(WasmRes.readText(Module, ptr));
      } catch (e) { reject(e); }
    });
  };

  /**
   * Export score as compressed MusicXML (.mxl) bytes.
   * @param {number} [excerptId=-1]
   * @returns {Promise<Uint8Array>}
   */
  Score.prototype.saveMxl = function (excerptId) {
    if (excerptId === undefined) excerptId = -1;
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('saveMxl', 'number', ['number', 'number'], [scorePtr, excerptId]);
        resolve(WasmRes.readData(Module, ptr));
      } catch (e) { reject(e); }
    });
  };

  /**
   * Get score title.
   * @returns {Promise<string>}
   */
  Score.prototype.title = function () {
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('title', 'number', ['number'], [scorePtr]);
        resolve(WasmRes.readText(Module, ptr));
      } catch (e) { reject(e); }
    });
  };

  /**
   * Get score metadata object.
   * @returns {Promise<Object>}
   */
  Score.prototype.metadata = function () {
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('saveMetadata', 'number', ['number'], [scorePtr]);
        var json = WasmRes.readText(Module, ptr);
        try { resolve(JSON.parse(json)); } catch (_) { resolve({}); }
      } catch (e) { reject(e); }
    });
  };

  /**
   * Get clef information for every staff in the score.
   *
   * Returns an array of objects, one per staff, ordered by staff index:
   *   { staffIndex, partIndex, partName, clef, clefType }
   *
   * This reads directly from the MuseScore data model, so it works correctly
   * for all file format versions (v2, v3, v4) without any XML parsing.
   *
   * Common clef values: 'treble', 'bass', 'alto', 'tenor', 'soprano', 'percussion'
   *
   * @returns {Promise<Array<{staffIndex: number, partIndex: number, partName: string, clef: string, clefType: number}>>}
   */
  Score.prototype.staffClefs = function () {
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('saveStaffClefs', 'number', ['number'], [scorePtr]);
        var json = WasmRes.readText(Module, ptr);
        try { resolve(JSON.parse(json)); } catch (_) { resolve([]); }
      } catch (e) { reject(e); }
    });
  };

  /**
   * Export score as MusicXML with clef elements guaranteed to be present.
   *
   * When the score is loaded with doLayout=false (the default), MuseScore's
   * MusicXML exporter omits <clef> elements from the first <attributes> block
   * of each part.  Renderers like OSMD then default all staves to treble clef,
   * causing bass/alto staves to render incorrectly.
   *
   * This method calls saveXml() and staffClefs() concurrently, then injects
   * the correct <clef> elements into any part that is missing them.  Use this
   * instead of saveXml() whenever the XML will be passed to a renderer.
   *
   * @param {number} [excerptId=-1] - Part index, -1 for full score
   * @returns {Promise<string>} Patched MusicXML string
   */
  Score.prototype.saveXmlWithClefs = function (excerptId) {
    return Promise.all([this.saveXml(excerptId), this.staffClefs()])
      .then(function (results) {
        return injectMissingClefs(results[0], results[1]);
      });
  };

  /**
   * Export score as a standard MIDI file (.mid).
   *
   * @param {boolean} [expandRepeats=true] - When true (default), repeat barlines
   *   and volta brackets are expanded so each repeated section appears only once.
   *   Pass false to export the score structure exactly as written.
   * @returns {Promise<Uint8Array>} Raw MIDI bytes (Standard MIDI File Type 1)
   */
  Score.prototype.saveMidi = function (expandRepeats) {
    if (expandRepeats === undefined) expandRepeats = true;
    var Module = this._module;
    var scorePtr = this._ptr;
    return new Promise(function (resolve, reject) {
      try {
        var ptr = Module.ccall('saveMidi', 'number', ['number', 'boolean'], [scorePtr, expandRepeats]);
        resolve(WasmRes.readData(Module, ptr));
      } catch (e) { reject(e); }
    });
  };

  /**
   * Free the score from WASM heap memory.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  Score.prototype.destroy = function () {
    if (!this._ptr) return;
    try {
      this._module.ccall('destroy', null, ['number'], [this._ptr]);
    } catch (_) { /* noop */ }
    this._ptr = 0;
  };

  // ---- Module loading ----

  function ensureModule() {
    if (modulePromise) return modulePromise;

    var libUrl = basePath + 'webmscore.lib.js';

    modulePromise = new Promise(function (resolve, reject) {
      if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
        if (window.createQtAppInstance) {
          resolve(window.createQtAppInstance);
          return;
        }
        var script = document.createElement('script');
        script.src = libUrl;
        script.onload = function () {
          if (window.createQtAppInstance) {
            resolve(window.createQtAppInstance);
          } else {
            reject(new Error('createQtAppInstance not found after loading webmscore.lib.js'));
          }
        };
        script.onerror = function () {
          reject(new Error('Failed to load ' + libUrl));
        };
        document.head.appendChild(script);
      } else if (typeof importScripts === 'function') {
        // Web Worker environment
        try {
          importScripts(libUrl);
          if (self.createQtAppInstance) {
            resolve(self.createQtAppInstance);
          } else {
            reject(new Error('createQtAppInstance not found after importScripts'));
          }
        } catch (e) { reject(e); }
      } else {
        reject(new Error('Unsupported environment for webmscore.js'));
      }
    })
      .then(function (factory) {
        return factory({
          locateFile: function (fileName) {
            return basePath + fileName;
          },
          print: function () { },
          printErr: function () { }
        });
      })
      .then(function (Module) {
        var argvPtr = Module._malloc(4);
        var arg0Buf = Module._malloc(16);
        Module.stringToUTF8('webmscore', arg0Buf, 16);
        Module.setValue(argvPtr, arg0Buf, 'i32');
        Module.ccall('init', null, ['number', 'number'], [1, argvPtr]);
        Module._free(arg0Buf);
        Module._free(argvPtr);
        return Module;
      });

    return modulePromise;
  }

  // Start loading immediately when the script is parsed
  var readyPromise = ensureModule();

  // ---- Public API ----

  window.WebMscore = {
    /**
     * Promise that resolves when the WASM engine is ready.
     * Await this before calling load().
     * @type {Promise<void>}
     */
    ready: readyPromise.then(function () { /* void */ }),

    /**
     * Load a score from binary data.
     *
     * @param {string} format - File format: 'mscz', 'mscx', 'mid', 'midi'
     * @param {Uint8Array} data - Raw file bytes
     * @param {null|Array} [fonts] - Reserved for future use, pass null
     * @param {boolean} [doLayout] - Run full layout (default: false)
     * @returns {Promise<Score>}
     */
    load: function (format, data, fonts, doLayout) {
      return ensureModule().then(function (Module) {
        var shouldLayout = doLayout === true;
        var dataPtr = getTypedArrayPtr(Module, data);
        var rp;
        try {
          rp = Module.ccall(
            'load',
            'number',
            ['string', 'number', 'number', 'number'],
            [format, dataPtr, data.byteLength, shouldLayout ? 1 : 0]
          );
        } finally {
          Module._free(dataPtr);
        }
        var scorePtr = WasmRes.readNum(Module, rp);
        return new Score(Module, scorePtr);
      });
    },

    /**
     * Get the MuseScore format version this WASM build supports.
     * For MuseScore 4.6.x this is 460.
     * @returns {Promise<number>}
     */
    version: function () {
      return ensureModule().then(function (Module) {
        return Module.ccall('version', 'number', [], []);
      });
    }
  };
})();
