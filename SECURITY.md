# Security policy

## Reporting

Please report vulnerabilities privately to the repository owner before opening a public issue. Include affected versions, reproduction steps, impact, and any suggested mitigation. Do not include real credentials or private repository content.

## Trust boundaries

- The daemon binds to localhost by default. Do not expose it on a network without adding authentication and transport security.
- `full-access` intentionally grants the native harness the authority available to the local process. Use it only in workspaces and with models you trust.
- `read-only` is enforced through each native harness's available sandbox/tool controls. The exact enforcement is reported in [`docs/native-harnesses.md`](./docs/native-harnesses.md); Cursor Cloud read-only requests are rejected.
- Plugins and TypeScript workflow files are trusted local code. Plugin trust is explicit in config, and `--no-plugins` provides recovery.
- Secrets belong in Keychain, native credential stores, or environment variables. They must never enter configuration, workflows, plugin manifests, SQLite, logs, events, or browser bootstrap data.
- The MCP bridge uses a daemon-derived per-agent token. Child mission, ancestry, depth, workspace, and permission ceiling are restored from trusted daemon state.

The repository does not bundle proprietary model assets or native-harness credentials.
