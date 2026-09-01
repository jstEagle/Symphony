#!/usr/bin/env bash
set -euo pipefail

# Exercise the daemon's separately-owned SQLite state stores across a real
# child-process SIGKILL. The test uses isolated temp directories and removes
# them in Vitest cleanup.
pnpm exec vitest run tests/acceptance/restart-state.acceptance.test.ts --reporter=verbose
