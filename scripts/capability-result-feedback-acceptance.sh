#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
exec pnpm exec vitest run tests/acceptance/capability-result-feedback.acceptance.test.ts --reporter=verbose
