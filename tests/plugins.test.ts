import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeDefaultConfig } from "../packages/config/src/index.js";
import { PluginHost } from "../packages/plugins/src/index.js";
import { createStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("trusted local plugins", () => {
  it("loads a Pi-compatible plugin only after explicit trust", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-plugin-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.plugins.trusted = ["example.release-review"];
    loaded.config.plugins.watch = false;
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    loaded.pluginRoots = [resolve(repository, "examples/plugins")];
    const store = createStore(loaded.dataDirectory);
    const host = new PluginHost(loaded, store);
    try {
      await host.start();
      expect(host.list().map((plugin) => plugin.manifest.id)).toEqual(["example.release-review"]);
      const registered = host.getTool("release_checklist");
      expect(registered?.plugin.manifest.piCompatible).toBe(true);
      expect(await registered?.tool.execute({})).toMatchObject({ checks: expect.any(Array) });
      expect(store.listPluginStates()).toContainEqual(expect.objectContaining({ id: "example.release-review", status: "active" }));
    } finally {
      await host.stop();
      store.close();
    }
  });
});
