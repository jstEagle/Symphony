# Symphony contributor instructions

- Keep non-secret configuration in `symphony.config.json`. Environment variables and the OS keychain are only for secrets, credentials, tokens, and API keys.
- The daemon is the only authority for orchestration state. Clients consume snapshots/events and send idempotent commands.
- Preserve native harness behavior. Drivers translate lifecycle, permissions, events, messages, usage, and cancellation; they do not replace native agent loops.
- `apps/web` is the frontend boundary. Do not edit it unless the task explicitly includes frontend work.
- Every mutating runtime command needs an idempotency key. Never infer that an unknown delivery succeeded.
- Plugins are trusted executable code. A failed rebuild must leave the last-known-good build active, and `--no-plugins` must remain a recovery path.
- Add protocol fixtures and tests when changing a driver, event, workflow IR, or plugin contract.
