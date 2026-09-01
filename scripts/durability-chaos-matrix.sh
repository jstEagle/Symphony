#!/usr/bin/env bash
set -euo pipefail

# Re-run the live daemon/SQLite/HTTP/SSE matrix for explicit deterministic
# seeds. Keep each Vitest invocation isolated so one failed generation leaves
# an actionable seed and cannot contaminate the next daemon store.
if (($# == 0)); then
  set -- 1 2 3
fi

for seed in "$@"; do
  if [[ ! "$seed" =~ ^[0-9]+$ ]]; then
    echo "durability chaos seed must be a non-negative integer: $seed" >&2
    exit 2
  fi
  echo "durability chaos matrix seed=$seed"
  SYMPHONY_CHAOS_SEED="$seed" pnpm exec vitest run tests/acceptance/durability-chaos-matrix.acceptance.test.ts --reporter=verbose
done
