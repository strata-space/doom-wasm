#!/usr/bin/env bash
#
# Rebuild `vendor/doom.js` and `vendor/doom.wasm` from upstream source.
#
# NOT part of any turbo/CI pipeline: it needs an Emscripten toolchain that
# neither CI nor a normal dev machine carries, and its output is committed
# (see vendor/README.md for why). Run it by hand when bumping the pinned
# upstream commit, then commit the regenerated artifacts.
#
# Requires: emscripten, automake, autoconf, git.
#   macOS: brew install emscripten automake autoconf
set -euo pipefail

PINNED_COMMIT="65e0d3ae2ffa604155eebd96ed40da6567bd08f4"
UPSTREAM="https://github.com/cloudflare/doom-wasm.git"

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor_dir="${package_dir}/vendor"
work_dir="${TMPDIR:-/tmp}/strata-doom-engine-build"

for tool in emcc emmake emconfigure autoreconf; do
  command -v "$tool" > /dev/null || {
    echo "error: '$tool' not found. Install the Emscripten toolchain and autotools first." >&2
    exit 1
  }
done

rm -rf "$work_dir"
git clone "$UPSTREAM" "$work_dir"
git -C "$work_dir" checkout --quiet "$PINNED_COMMIT"

for patch in "${package_dir}"/patches/*.patch; do
  echo "applying $(basename "$patch")"
  git -C "$work_dir" apply "$patch"
done

cd "$work_dir"
autoreconf -fiv

# Three probes in autoconf 2.7x cannot be answered by emcc, and each one
# aborts configure before it reaches a single source file:
#   ac_cv_exeext       emcc emits .html/.js, not a native executable
#   ac_cv_prog_cc_c23  emcc's clang rejects the C23 conformance probe
#   ac_cv_c_undeclared_builtin_options
#                      the "report undeclared builtins" probe cannot link
# Preseeding the cache variables answers them without weakening the build.
ac_cv_exeext=".html" \
  ac_cv_prog_cc_c23=no \
  ac_cv_c_undeclared_builtin_options='none needed' \
  emconfigure ./configure --host=none-none-none CFLAGS='-O2 -fno-strict-aliasing'

emmake make -j"$(getconf _NPROCESSORS_ONLN)"

# The link emits DWARF regardless of -O level, which triples the binary and
# is useless to a reader. Stripping is a separate post-link pass.
# Not derived from `command -v emcc`: on Homebrew that resolves to a shim
# in bin/, whose ../libexec does not exist. Ask brew where the formula
# actually lives, and fall back to a wasm-opt already on PATH (emsdk
# installs put one there).
wasm_opt="$(command -v wasm-opt || true)"
if [ -z "$wasm_opt" ] && command -v brew > /dev/null; then
  wasm_opt="$(brew --prefix emscripten 2> /dev/null)/libexec/binaryen/bin/wasm-opt"
fi
[ -x "$wasm_opt" ] || {
  echo "error: wasm-opt not found. It ships with emscripten/binaryen; put it on PATH." >&2
  exit 1
}

cp "${work_dir}/src/websockets-doom.js" "${vendor_dir}/doom.engine.js"
"$wasm_opt" --strip-debug --strip-producers -O2 \
  --enable-bulk-memory-opt --enable-nontrapping-float-to-int \
  "${work_dir}/src/websockets-doom.wasm" -o "${vendor_dir}/doom.wasm"

node "${package_dir}/scripts/compose-doom-js.mjs"

echo
echo "rebuilt:"
ls -la "${vendor_dir}/doom.js" "${vendor_dir}/doom.wasm"
echo
echo "Commit the regenerated artifacts, and update vendor/README.md if the"
echo "pinned commit changed."
