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
