#!/usr/bin/env bash
set -euo pipefail

# Run real child-daemon/SIGKILL acceptance in isolated stores. A seed only
# perturbs fixture timing; it is not a credential or a production setting.
if (($# == 0)); then
  set -- 1 2 3 5 8
fi

for seed in "$@"; do
  if [[ ! "$seed" =~ ^[0-9]+$ ]]; then
    echo "process-crash seed must be a non-negative integer: $seed" >&2
    exit 2
  fi
  echo "process-crash acceptance seed=$seed"
  SYMPHONY_PROCESS_CRASH_SEED="$seed" pnpm exec vitest run tests/acceptance/process-crash-boundary.acceptance.test.ts --reporter=verbose
done
