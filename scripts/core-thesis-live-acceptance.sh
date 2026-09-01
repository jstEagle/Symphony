#!/usr/bin/env bash
set -euo pipefail

pnpm exec vitest run tests/acceptance/core-thesis-live.acceptance.test.ts --reporter=verbose
