# Corresponding source for Strata's WebAssembly Doom

This directory exists to satisfy the GNU General Public License. Strata
serves a compiled WebAssembly build of Chocolate Doom to browsers, inside
the sandboxed `html` code-block previews at strata.space. That binary is
a GPL-2.0-or-later work, so its complete corresponding source has to be
available to anyone who receives it. This repository IS that source.

## What was built, and from what

The repository is [cloudflare/doom-wasm][upstream] at commit
`65e0d3ae2ffa604155eebd96ed40da6567bd08f4`, with two patches applied.
Both are visible in the history and reproduced under `patches/`:

- **`0001-consistent-boolean-width`** — upstream types `boolean` as a
  1-byte `bool` in any translation unit that has seen `<stdbool.h>` and
  as a 4-byte enum everywhere else. Under Emscripten the SDL headers
  pull in `<stdbool.h>`, so the two halves of the program disagreed on
  the size of every `boolean` global, and a 4-byte store to `netgame`
  overwrote its neighbours. AddressSanitizer reported it as a
  global-buffer-overflow; without instrumentation it surfaced as a wasm
  out-of-bounds trap in `P_PlayerThink` about five seconds in, when the
  title screen hands off to the attract-mode demo.

  The fix makes `boolean` one `int`-sized type in every translation
  unit. `int`, not `bool`: vanilla stores tri-state values in `boolean`
  fields (`R_InstallSpriteLump` memsets `sprtemp` to -1 for "rotation
  undetermined", then switches on `case -1`), and narrowing those to a
  real `bool` makes the sprite loader reject legitimate WADs.

- **`0002-emscripten-build-flags`** — modernises the link flags for
  current Emscripten. `EXTRA_EXPORTED_RUNTIME_METHODS` was removed in
  favour of `EXPORTED_RUNTIME_METHODS`, and the build needs a growable
  heap with a larger initial size.

## Rebuilding

`build-engine.sh` is the script Strata runs. It needs an Emscripten
toolchain and autotools:

```bash
brew install emscripten automake autoconf   # or your platform's equivalent
./strata/build-engine.sh
```

It clones the pinned commit, applies `patches/`, configures, builds, and
strips the result with `wasm-opt`.

The script preseeds three autoconf cache variables. Autoconf 2.7x probes
for a C23 compiler, a native executable extension, and undeclared-builtin
flags; none can be answered by `emcc`, and each aborts `configure` before
it reaches a source file.

`compose-doom-js.mjs` then concatenates the Emscripten glue with a small
auto-boot shim to produce the single `doom.js` Strata serves. The shim is
not part of the GPL work's source in any interesting sense, but it is
included here because it is what actually ships and reading it explains
the file.

## Game data

The binary is shipped alongside [Freedoom][freedoom] Phase 1 v0.13.0
(`freedoom1.wad`), which is BSD-3-Clause and NOT part of this repository.
No commercial or shareware Doom WAD is distributed by Strata.

## Licensing

Chocolate Doom and this derivative are GPL-2.0-or-later. See `COPYING.md`
at the repository root. Copyright (C) 1993-1996 Id Software, Inc.;
(C) 2005-2024 Simon Howard and contributors.

[upstream]: https://github.com/cloudflare/doom-wasm
[freedoom]: https://github.com/freedoom/freedoom
