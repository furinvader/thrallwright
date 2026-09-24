#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
nix build .#thrallwright

node scripts/package-smoke.mjs "$(readlink -f result)"
