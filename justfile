set export
set positional-arguments
set quiet

# Show the available developer commands.
default:
    @just --list

# Install locked JavaScript dependencies and build shared contracts.
setup:
    pnpm install --frozen-lockfile
    bash scripts/prepare-native.sh
    pnpm --filter @thrallwright/contracts build

# Start contracts, server, and browser development processes together.
dev:
    pnpm dev

# Check formatting, lint, types/templates, and fast tests.
check:
    pnpm check

# Run fast tests, optionally in one package with runner arguments.
test *args:
    pnpm test "$@"

# Run browser-to-service workflows with Playwright.
test-e2e *args:
    pnpm build
    pnpm test:e2e "$@"

# Produce backend, shared contracts, and browser release assets.
build:
    pnpm build

# Apply source formatting explicitly.
format:
    pnpm format

# Run a real Codex integration smoke test when credentials are available.
probe *args:
    node scripts/codex-probe.mjs "$@"

# Build the Nix package and test its runtime from outside this checkout.
package-smoke:
    bash scripts/package-smoke.sh
