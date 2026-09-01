# Operator and MCP live acceptance

Run `./scripts/operator-mcp-live-acceptance.sh` from the repository root.

The acceptance test starts the actual daemon as a child process with a
temporary config and SQLite directory. It creates an authenticated full-access
agent through the daemon HTTP API, invokes the dev `apps/cli/src/index.ts`
operator surface, and drives the actual `apps/mcp/src/index.ts` stdio server.
The MCP server's requests go through its real HTTP client to the daemon.

The test covers capability create/list/activate/prepare, semantic message
send/replay/delivery receipt/cancellation, diagnostics export, and daemon
restart. It repeats CLI mutations after restart with the same idempotency keys
and checks that MCP message receipts and replay cursors remain durable.

No provider, native harness, daemon, or storage implementation is mocked. The
test intentionally disables configured harnesses and plugins so it does not
contact external services or launch a real provider. All child processes have
bounded readiness/CLI timeouts and are cleaned up; temporary data is removed
after the test.
