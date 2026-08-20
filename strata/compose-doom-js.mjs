#!/usr/bin/env node
/**
 * Compose `vendor/doom.js` from the Emscripten glue (`doom.engine.js`,
 * emitted by `build-engine.sh`) and the author-facing shim below.
 *
 * ONE file, not two, because every additional loadable path under
 * `/sandbox/libs/` widens the sandbox CSP, and CSP path matching ignores
 * the query string — so each allowed path is somewhere block content
 * could encode data into a request URL. The vetted set is deliberately a
 * list of exact filenames; keeping the shim and the glue in one file
 * keeps that list one entry shorter.
 *
 * The glue is wrapped in an IIFE with our own `Module` in scope. The
 * glue's own `var Module = typeof Module != 'undefined' ? Module : {}`
 * then resolves to ours rather than creating a global, so a preview's
 * `window.Module` stays untouched and two engines could coexist. This is
 * done here rather than with Emscripten's MODULARIZE because the flag
 * did not survive this project's autotools link step, and doing it at
 * compose time is both verifiable and independent of the toolchain.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const glue = readFileSync(resolve(vendorDir, 'doom.engine.js'), 'utf8');

if (glue.includes('</script')) {
  // The composed file is served as a standalone script, but a preview may
  // also inline it; a closing tag in the payload would end the element.
  console.error('[compose-doom-js] engine glue contains a closing script tag');
  process.exit(1);
}

/**
 * Runtime asset URLs, as exact same-origin paths with no query string.
 *
 * These MUST match `SANDBOX_FETCHABLE_ASSET_FILES` in
 * `packages/webapp/src/sandbox/csp.ts`: the sandbox CSP names them in
 * `connect-src`, the frame bootstrap's `confineNetworkChannels()` admits
 * exactly these two URLs, and the CloudFront guard refuses anything else
 * under `/sandbox/`. A query string on either one is refused by all
 * three, so nothing here may add one.
 */
const PRELUDE = `/*
 * Doom for Strata HTML sandbox previews.
 *
 * ENGINE: Chocolate Doom compiled to WebAssembly.
 *   Copyright (C) 1993-1996 Id Software, Inc.
 *   Copyright (C) 2005-2024 Simon Howard and contributors.
 *   Licensed under the GNU General Public License, version 2 or later.
 *   This program is distributed WITHOUT ANY WARRANTY; without even the
 *   implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
 *   PURPOSE. See the GNU General Public License for more details.
 *
 * SOURCE: this file is a compiled work, and its complete corresponding
 * source is published at
 *
 *   https://github.com/strata-space/doom-wasm
 *
 * which is github.com/cloudflare/doom-wasm at commit
 * 65e0d3ae2ffa604155eebd96ed40da6567bd08f4 with two patches applied
 * (consistent boolean width, Emscripten link flags), alongside the build
 * and compose scripts that produced this file. Accompanying the binary
 * with its source this way is what GPL-2.0 asks for; no request or
 * correspondence is needed.
 *
 * GAME DATA: Freedoom (freedoom1.wad), BSD 3-Clause, from
 *   github.com/freedoom/freedoom. Copyright (C) 2001-2024 Contributors
 *   to the Freedoom project. No commercial or shareware Doom WAD is
 *   distributed with this file.
 *
 * Full license texts accompany the source at
 * packages/doom-engine/licenses/.
 *
 * Usage inside an \`html\` code block:
 *
 *   <script src="/sandbox/libs/doom.js"><\\/script>
 *
 * That is the whole thing: the script appends its own canvas and boots.
 * Click the preview once to give it keyboard focus. Options ride on the
 * script tag:
 *
 *   <script src="/sandbox/libs/doom.js" data-doom-warp="1,1"
 *           data-doom-skill="3"><\\/script>
 *
 * To place the canvas yourself, supply one with id="canvas" and it will
 * be used instead of an appended one.
 */
(function () {
  'use strict';

  // Captured while this script is still executing: document.currentScript
  // is null by the time a deferred DOMContentLoaded boot would read it.
  var SCRIPT_TAG = document.currentScript;

  var IWAD_NAME = 'freedoom1.wad';

  /**
   * Asset URLs, resolved against THIS SCRIPT's own URL rather than
   * written as site-relative paths.
   *
   * The two environments disagree about what a site-relative path means.
   * In the editor the frame has a real origin and "/sandbox/libs/x"
   * resolves fine. In PDF export the block runs in an opaque-origin
   * srcdoc frame with no base to resolve against, so the same string
   * fails to parse, the engine never fetches its wasm, and the export
   * captures a correctly sized black rectangle. Deriving from the script
   * URL yields the right absolute URL in both, and matches what
   * connect-src names in each: the real origin live, the interceptor's
   * synthetic origin in export.
   */
  function assetUrl(name) {
    var base = SCRIPT_TAG && SCRIPT_TAG.src;
    if (base) {
      try {
        return new URL(name, base).href;
      } catch (e) {
        // Fall through to the site-relative form below.
      }
    }
    return '/sandbox/libs/' + name;
  }

  var WASM_URL = assetUrl('doom.wasm');
  var IWAD_URL = assetUrl(IWAD_NAME);

  /**
   * Resolve the canvas the engine will draw into, and make sure it is
   * reachable under the id "canvas".
   *
   * That id is load-bearing, not decoration. Emscripten's SDL2 port
   * splits the two jobs across two different lookups: it RENDERS through
   * Module['canvas'], but SIZES the window through the HTML5 API's
   * default "#canvas" selector. Give it an element under any other id and
   * the two disagree: the picture is drawn at the engine's real
   * resolution into a canvas still at its 300x150 default, so the reader
   * sees a magnified crop of the top-left corner. Measured, then fixed
   * here rather than documented as an author footgun.
   */
  function findCanvas() {
    var canvas =
      document.getElementById('canvas') ||
      document.querySelector('canvas[data-doom]') ||
      document.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      (document.body || document.documentElement).appendChild(canvas);
    }
    canvas.id = 'canvas';
    return canvas;
  }

  /** Options come off the script tag, falling back to the canvas. */
  function option(canvas, name) {
    var attr = 'data-doom-' + name;
    if (SCRIPT_TAG && SCRIPT_TAG.hasAttribute(attr)) return SCRIPT_TAG.getAttribute(attr);
    return canvas.getAttribute(attr);
  }

  /**
   * Command line for the engine.
   *
   * \`-nomusic\` is not a preference: with music enabled this build wedges
   * during sound init and never reaches the title screen. Sound effects
   * are unaffected. \`-nogui\` skips the native setup dialog, and
   * \`-window\` keeps the engine inside our canvas rather than asking for
   * fullscreen (which the sandbox denies anyway).
   */
  function argsFor(canvas) {
    var args = ['-iwad', IWAD_NAME, '-window', '-nogui', '-nomusic'];
    var warp = option(canvas, 'warp');
    if (warp) {
      var parts = warp.split(',');
      args = args.concat(['-warp']).concat(parts.map(function (p) { return p.trim(); }));
    }
    var skill = option(canvas, 'skill');
    if (skill) args = args.concat(['-skill', skill.trim()]);
    return args;
  }

  function start(options) {
    var opts = options || {};
    var canvas = opts.canvas || findCanvas();
    // The canvas needs a DEFINITE CSS pixel size before the engine
    // initialises video, because SDL reads the element's rendered size to
    // choose its video mode (and therefore the backing store). A
    // percentage width with "height:auto" is not definite: the canvas
    // still has its 300x150 default aspect at that moment, so the engine
    // renders a 300x150 picture that CSS then blows up into a blurry
    // crop. Measured, not assumed.
    //
    // So: resolve one concrete size here, from the space the preview
    // actually has, at 8:5 (the 320x200 picture at its intended 2x).
    // The max-width rule keeps it inside a narrow frame afterwards.
    var available = 0;
    if (canvas.parentNode && canvas.parentNode.clientWidth) {
      available = canvas.parentNode.clientWidth;
    }
    if (!available) available = document.documentElement.clientWidth || 640;
    var displayWidth = Math.max(320, Math.min(Math.floor(available), 960));
    var displayHeight = Math.round((displayWidth * 5) / 8);
    // Sizing goes in a STYLESHEET, never on canvas.style: the engine's
    // Browser.updateCanvasDimensions() calls
    // canvas.style.removeProperty('width'/'height') whenever it resizes,
    // which deletes INLINE properties only. A stylesheet rule survives it.
    //
    // Nearest-neighbour keeps 1993 pixel art crisp rather than smeared.
    canvas.classList.add('strata-doom-canvas');
    var style = document.getElementById('strata-doom-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'strata-doom-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent =
      '.strata-doom-canvas{display:block;margin:0 auto;' +
      'width:' + displayWidth + 'px;height:' + displayHeight + 'px;' +
      'max-width:100%;background:#000;image-rendering:pixelated;' +
      'image-rendering:crisp-edges;outline:none}';
    // Keys only reach the engine while the canvas has focus, and a canvas
    // is not focusable without a tabindex. Readers still click it first;
    // this is what makes that click do something.
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    canvas.addEventListener('click', function () { canvas.focus(); });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    var Module = {
      canvas: canvas,
      noInitialRun: true,
      // The engine's own arg parser reads this; see argsFor().
      arguments: opts.args || argsFor(canvas),
      locateFile: function (path) {
        return path.slice(-5) === '.wasm' ? WASM_URL : path;
      },
      preRun: [
        function () {
          // Fetched here rather than via createPreloadedFile so the bytes
          // can be handed to MEMFS with canOwn.
          //
          // createPreloadedFile downloads into an ArrayBuffer and then MEMFS
          // COPIES it, so a 27.5 MB IWAD costs ~55 MB at peak. On a phone
          // that transient double is the difference between fitting in the
          // tab's budget and being discarded, and it buys nothing: the
          // fetched buffer has no other owner. canOwn hands it over instead.
          //
          // The run-dependency pair is what makes an async fetch legal in
          // preRun: the runtime waits for the file before main() reads it.
          Module.addRunDependency('iwad');
          fetch(IWAD_URL)
            .then(function (response) {
              if (!response.ok) throw new Error('IWAD ' + response.status);
              return response.arrayBuffer();
            })
            .then(function (buffer) {
              Module.FS.createDataFile(
                '/',
                IWAD_NAME,
                new Uint8Array(buffer),
                true,
                true,
                true,
              );
              Module.removeRunDependency('iwad');
            })
            .catch(function (error) {
              // Surfaced rather than swallowed: without the IWAD the engine
              // exits with a bare I_Error the reader cannot act on.
              Module.printErr('Doom could not load its game data: ' + error.message);
              Module.removeRunDependency('iwad');
            });
        },
      ],
      onRuntimeInitialized: function () {
        Module.callMain(Module.arguments);
      },
      print: function () {},
      printErr: function () {},
    };

    /* BEGIN emscripten glue */
`;

const POSTLUDE = `
    /* END emscripten glue */

    return Module;
  }

  var api = { start: start };
  try {
    Object.defineProperty(window, 'Doom', {
      value: api,
      writable: false,
      configurable: false,
    });
  } catch (e) {
    window.Doom = api;
  }

  // Auto-boot unless the author opted out with
  // <script src="..." data-doom-manual></script>, in which case they call
  // Doom.start() themselves.
  if (!SCRIPT_TAG || !SCRIPT_TAG.hasAttribute('data-doom-manual')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { start(); });
    } else {
      start();
    }
  }
})();
`;

// The glue is indented into the function body purely so the composed file
// reads as one program; Emscripten's output is not indentation-sensitive.
writeFileSync(resolve(vendorDir, 'doom.js'), PRELUDE + glue + POSTLUDE);
console.log('[compose-doom-js] wrote vendor/doom.js');
