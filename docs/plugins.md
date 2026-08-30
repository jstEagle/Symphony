# Plugins

Symphony plugins use the same default-export factory style as Pi extensions. This lets Pi create a useful extension and lets Symphony load the same basic `registerTool`, `registerCommand`, and `on` calls.

## Trust and hot reload

Plugins execute as local code with the daemon's operating-system permissions. A plugin ID must be listed in `plugins.trusted` in `symphony.config.json`; otherwise it is visible as `quarantined` and never executes.

The host watches configured roots, hashes the complete local source tree, builds TypeScript atomically, initializes a candidate registration, and only then swaps it into the active registry. A failed build or factory keeps the previous plugin active and records the error. `symphony --no-plugins` is the recovery switch.

## Manifest

```json
{
  "id": "example.release-review",
  "name": "Release review",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "index.ts",
  "piCompatible": true,
  "contributes": {
    "webEntry": "web/index.tsx",
    "workflows": ["workflows/release.workflow.ts"],
    "modelCatalogs": ["catalog/models.json"]
  }
}
```

`webEntry` is retained as declarative manifest metadata; the daemon never evaluates browser code. The current command center exposes active plugin state and stable named slots, while trusted backend tools, workflows, events, and model catalogs hot reload through the plugin host. During UI development an agent edits `apps/web` directly and Vite applies the change with hot module replacement; loading arbitrary third-party React bundles into the command center is intentionally not part of the v1 trust boundary. Model catalogs can supply the narrow metrics Symphony accepts. Workflow contributions go through the normal compiler and immutable revision store.

Trusted plugin tools are listed through `list_plugin_tools` and called through `call_plugin_tool`, so MCP-capable workers do not need a daemon restart when tools hot reload.

See [`examples/plugins/release-review`](../examples/plugins/release-review).
