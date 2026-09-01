#!/usr/bin/env bash
set -euo pipefail

# Keep this suite isolated from the broad repository check so it can be used
# as a focused acceptance gate while the next-generation harness evolves.
pnpm exec vitest run tests/acceptance/objective-control-harness.acceptance.test.ts --reporter=verbose
