# Contributing

Symphony is intentionally thin. Prefer native, documented harness APIs over transcript scraping or terminal automation. Keep repository memory/RAG, generic model loops, and provider secrets out of the orchestration core.

Before submitting a change:

```bash
pnpm install
pnpm check
```

Add deterministic fixtures for driver protocol changes. Tests must distinguish offline contract coverage from live provider validation. Do not make a harness appear authenticated or connected based only on an installed package.

Non-secret behavior belongs in `symphony.config.json`; secrets belong only in the OS keychain, provider-native stores, or environment variables. Preserve output-schema validation, command/trigger idempotency, immutable workflow missions, and read-only permission inheritance.

The frontend lives in `apps/web` and is intentionally isolated from the daemon packages. Keep the browser a projection/control surface over `/v1/bootstrap` and `/v1/events`; do not make client state authoritative.

## Agent-authored fixes

Symphony keeps durable per-agent lifecycle logs. Reproduce a failure, then inspect it with `symphony logs <agent-id>` or the `get_session_logs` coordination tool. Bug reports and pull requests should quote the smallest relevant cursor range, native harness/model, Symphony version, and validation performed; never paste credentials or provider tokens.

Agents working directly for the repository owner may edit the owner's local checkout when explicitly asked. Every other automated contributor must create a topic branch or fork, make the smallest coherent fix, run `pnpm check`, and open a pull request targeting `main`. External agents must not push directly to `main`, publish a release, or deploy production. A pull request should explain the observed failure, its durable log evidence, the fix, and which checks are live-provider evidence versus deterministic local coverage.
