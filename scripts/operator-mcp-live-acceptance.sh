#!/usr/bin/env bash
set -euo pipefail

# Starts an isolated real daemon, invokes the dev CLI and MCP stdio client,
# then restarts the daemon to verify durable state and idempotent replays.
pnpm exec vitest run tests/acceptance/operator-mcp-live.acceptance.test.ts --reporter=verbose
