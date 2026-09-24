#!/usr/bin/env bash
set -euo pipefail

# Angular uses Sass's optional embedded Dart binary. Its npm tarball has an
# FHS dynamic-loader path, so it needs the selected Nix glibc when on NixOS.
if [[ -z "${THRALLWRIGHT_DYNAMIC_LINKER:-}" || -z "${THRALLWRIGHT_GLIBC_LIB:-}" ]]; then
  echo 'Run setup inside `nix develop` to select the native toolchain.' >&2
  exit 1
fi

found=false
for dart in node_modules/.pnpm/sass-embedded-linux-*/node_modules/sass-embedded-linux-*/dart-sass/src/dart; do
  [[ -f "$dart" ]] || continue
  found=true
  chmod u+w "$dart"
  patchelf --set-interpreter "$THRALLWRIGHT_DYNAMIC_LINKER" \
    --set-rpath "$THRALLWRIGHT_GLIBC_LIB" "$dart"
done
if [[ "$found" == false ]]; then
  echo 'Embedded Sass executable missing from locked dependencies.' >&2
  exit 1
fi
