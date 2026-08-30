import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MacOsKeychainBackend,
  SecretStore,
  environmentWithoutDaemonSecret,
  isDaemonSecretKey,
  type NativeSecretBackend,
} from "../packages/config/src/index.js";
import {
  DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY,
  DAEMON_CREDENTIAL_GENERATION_METADATA_KEY,
  DAEMON_CREDENTIAL_ID_METADATA_KEY,
  LEGACY_DAEMON_SECRET_METADATA_KEY,
  daemonCredentialFingerprint,
  resolveDaemonCredential,
} from "../apps/daemon/src/daemon-credential.js";
import { createStore } from "../packages/storage/src/index.js";
import { startDaemon, SymphonyDaemon } from "../apps/daemon/src/index.js";

const LEGACY_SECRET = "a".repeat(64);
const EXTERNAL_SECRET = "b".repeat(64);
const GENERATED_SECRET = "c".repeat(64);
const CREDENTIAL_ID = "credential-fixture";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class MemorySecretBackend implements NativeSecretBackend {
  readonly values = new Map<string, string>();
  setCalls = 0;

  get(service: string): string | null {
    return this.values.get(service) ?? null;
  }

  set(service: string, _account: string, value: string): void {
    this.setCalls += 1;
    this.values.set(service, value);
  }

  delete(service: string): boolean {
    return this.values.delete(service);
  }
}

class MismatchedReadbackBackend extends MemorySecretBackend {
  override set(service: string, account: string, _value: string): void {
    super.set(service, account, EXTERNAL_SECRET);
  }
}

class FailingWriteBackend extends MemorySecretBackend {
  override set(): void {
    throw new Error("fixture Keychain write failed");
  }
}

function fixture(options: { platform: NodeJS.Platform; environment?: NodeJS.ProcessEnv; backend?: MemorySecretBackend }) {
  const root = mkdtempSync(join(tmpdir(), "symphony-daemon-credential-"));
  temporary.push(root);
  const store = createStore(root);
  const secrets = new SecretStore("dev.symphony.tests", {
    platform: options.platform,
    environment: options.environment ?? {},
    ...(options.backend ? { nativeBackend: options.backend } : {}),
    account: "fixture-user",
  });
  return { store, secrets };
}

function resolve(
  store: ReturnType<typeof createStore>,
  secrets: SecretStore,
  platform: NodeJS.Platform,
) {
  return resolveDaemonCredential(store, secrets, {
    platform,
    randomCredentialId: () => CREDENTIAL_ID,
    randomSecret: () => GENERATED_SECRET,
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return port;
}

describe("daemon credential Release 1 resolution", () => {
  it("copies the exact legacy root into Keychain and retains the SQLite rollback shadow", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);

    const credential = resolve(store, secrets, "darwin");

    expect(credential).toMatchObject({
      secret: LEGACY_SECRET,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      state: "legacy-migrated",
      allowNewCredentials: true,
    });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBe(LEGACY_SECRET);
    expect(store.getMetadata(DAEMON_CREDENTIAL_ID_METADATA_KEY)).toBe(CREDENTIAL_ID);
    expect(store.getMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY)).toBe(1);
    expect(store.getMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY)).toBe(daemonCredentialFingerprint(LEGACY_SECRET));
    expect([...backend.values.values()]).toEqual([LEGACY_SECRET]);
    store.close();
  });

  it("creates a new Darwin root only in the external store", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });

    const credential = resolve(store, secrets, "darwin");

    expect(credential).toMatchObject({ secret: GENERATED_SECRET, state: "external", allowNewCredentials: true });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBeNull();
    expect([...backend.values.values()]).toEqual([GENERATED_SECRET]);
    store.close();
  });

  it.each([
    ["write failure", new FailingWriteBackend()],
    ["readback mismatch", new MismatchedReadbackBackend()],
  ])("recovers retained work in compatibility mode after a Darwin %s", (_label, backend) => {
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);

    expect(resolve(store, secrets, "darwin")).toMatchObject({
      secret: LEGACY_SECRET,
      state: "legacy-compatibility",
      location: "legacy-sqlite",
      allowNewCredentials: false,
    });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBe(LEGACY_SECRET);
    expect(store.getMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY)).toBe(daemonCredentialFingerprint(LEGACY_SECRET));
    store.close();
  });

  it("uses an exact headless environment match without rotating the legacy root", () => {
    const { store, secrets } = fixture({
      platform: "linux",
      environment: { SYMPHONY_DAEMON_SECRET: LEGACY_SECRET },
    });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);

    const credential = resolve(store, secrets, "linux");

    expect(credential).toMatchObject({ secret: LEGACY_SECRET, state: "external", allowNewCredentials: true });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBe(LEGACY_SECRET);
    store.close();
  });

  it("resolves a case-insensitive Windows headless environment name", () => {
    const { store, secrets } = fixture({
      platform: "win32",
      environment: { Symphony_Daemon_Secret: EXTERNAL_SECRET },
    });

    expect(resolve(store, secrets, "win32")).toMatchObject({
      secret: EXTERNAL_SECRET,
      state: "external",
      allowNewCredentials: true,
    });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBeNull();
    store.close();
  });

  it.each([
    ["missing", {}],
    ["mismatched", { SYMPHONY_DAEMON_SECRET: EXTERNAL_SECRET }],
  ])("preserves existing work in headless legacy compatibility mode when the external root is %s", (_label, environment) => {
    const { store, secrets } = fixture({ platform: "linux", environment });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);

    const credential = resolve(store, secrets, "linux");

    expect(credential).toMatchObject({
      secret: LEGACY_SECRET,
      state: "legacy-compatibility",
      location: "legacy-sqlite",
      allowNewCredentials: false,
    });
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBe(LEGACY_SECRET);
    store.close();
  });

  it("fails a new headless install before creating a plaintext fallback", () => {
    const { store, secrets } = fixture({ platform: "linux" });

    expect(() => resolve(store, secrets, "linux")).toThrow("SYMPHONY_DAEMON_SECRET is required");
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBeNull();
    store.close();
  });

  it("fails daemon startup before binding a port on a new headless install", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-headless-daemon-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      server: { host: "127.0.0.1", port, openBrowser: false },
    }));
    const secrets = new SecretStore("dev.symphony.tests", { platform: "linux", environment: {} });

    await expect(startDaemon({
      rootDirectory: root,
      noPlugins: true,
      secretStore: secrets,
      credentialPlatform: "linux",
    })).rejects.toThrow("SYMPHONY_DAEMON_SECRET is required");

    const probe = createServer();
    await expect(new Promise<void>((resolveReady, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolveReady);
    })).resolves.toBeUndefined();
    await new Promise<void>((resolveClosed) => probe.close(() => resolveClosed()));
    const store = createStore(join(root, ".symphony"));
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBeNull();
    store.close();
  });

  it("consumes the headless root from ambient process state before drivers and plugins are constructed", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-headless-ambient-"));
    temporary.push(root);
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      server: { host: "127.0.0.1", port: await availablePort(), openBrowser: false },
    }));
    const original = process.env.SYMPHONY_DAEMON_SECRET;
    process.env.SYMPHONY_DAEMON_SECRET = EXTERNAL_SECRET;
    let daemon: SymphonyDaemon | null = null;
    try {
      daemon = new SymphonyDaemon({
        rootDirectory: root,
        noPlugins: true,
        acquireLease: true,
        credentialPlatform: "linux",
      });
      expect(process.env.SYMPHONY_DAEMON_SECRET).toBeUndefined();
    } finally {
      await daemon?.close();
      if (original === undefined) delete process.env.SYMPHONY_DAEMON_SECRET;
      else process.env.SYMPHONY_DAEMON_SECRET = original;
    }
  });

  it("does not reuse one daemon authority's consumed environment root for a fresh data directory", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "symphony-headless-authority-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "symphony-headless-authority-b-"));
    temporary.push(firstRoot, secondRoot);
    for (const [root, port] of [
      [firstRoot, await availablePort()],
      [secondRoot, await availablePort()],
    ] as const) {
      writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
        server: { host: "127.0.0.1", port, openBrowser: false },
      }));
    }
    const original = process.env.SYMPHONY_DAEMON_SECRET;
    process.env.SYMPHONY_DAEMON_SECRET = EXTERNAL_SECRET;
    let first: SymphonyDaemon | null = null;
    try {
      first = new SymphonyDaemon({
        rootDirectory: firstRoot,
        noPlugins: true,
        acquireLease: true,
        credentialPlatform: "linux",
      });
      expect(() => new SymphonyDaemon({
        rootDirectory: secondRoot,
        noPlugins: true,
        acquireLease: true,
        credentialPlatform: "linux",
      })).toThrow("SYMPHONY_DAEMON_SECRET is required");
    } finally {
      await first?.close();
      if (original === undefined) delete process.env.SYMPHONY_DAEMON_SECRET;
      else process.env.SYMPHONY_DAEMON_SECRET = original;
    }
  });

  it("treats a present null legacy row as corruption instead of a missing credential", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, null);

    expect(() => resolve(store, secrets, "darwin")).toThrow(`Invalid ${LEGACY_DAEMON_SECRET_METADATA_KEY} metadata`);
    expect([...backend.values.values()]).toEqual([]);
    store.close();
  });

  it("does not generate over an unavailable Keychain item once a fingerprint exists", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(DAEMON_CREDENTIAL_ID_METADATA_KEY, CREDENTIAL_ID);
    store.setMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY, 1);
    store.setMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY, daemonCredentialFingerprint(LEGACY_SECRET));

    expect(() => resolve(store, secrets, "darwin")).toThrow("external daemon credential is unavailable");
    expect([...backend.values.values()]).toEqual([]);
    store.close();
  });

  it("does not overwrite Keychain when the legacy root conflicts with durable fingerprint metadata", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);
    store.setMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY, daemonCredentialFingerprint(EXTERNAL_SECRET));

    expect(() => resolve(store, secrets, "darwin")).toThrow("legacy daemon credential does not match");
    expect(backend.setCalls).toBe(0);
    expect([...backend.values.values()]).toEqual([]);
    expect(store.getMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY)).toBe(LEGACY_SECRET);
    store.close();
  });

  it("does not touch Keychain when durable fingerprint metadata is malformed", () => {
    const backend = new MemorySecretBackend();
    const { store, secrets } = fixture({ platform: "darwin", backend });
    store.setMetadata(LEGACY_DAEMON_SECRET_METADATA_KEY, LEGACY_SECRET);
    store.setMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY, "not-a-fingerprint");

    expect(() => resolve(store, secrets, "darwin")).toThrow("Durable daemon credential fingerprint");
    expect(backend.setCalls).toBe(0);
    expect([...backend.values.values()]).toEqual([]);
    store.close();
  });

  it("fails closed when an external root changes after its fingerprint was committed", () => {
    const { store, secrets } = fixture({
      platform: "linux",
      environment: { SYMPHONY_DAEMON_SECRET: EXTERNAL_SECRET },
    });
    store.setMetadata(DAEMON_CREDENTIAL_ID_METADATA_KEY, CREDENTIAL_ID);
    store.setMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY, 1);
    store.setMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY, daemonCredentialFingerprint(LEGACY_SECRET));

    expect(() => resolve(store, secrets, "linux")).toThrow("does not match the durable credential fingerprint");
    store.close();
  });
});

describe("macOS Keychain command transport", () => {
  it("sends encoded secret bytes through interactive stdin with a bounded, non-secret argv", () => {
    const calls: Array<{
      args: string[];
      input?: string;
      output: "capture" | "capture-error" | "ignore";
      timeoutMs: number;
    }> = [];
    const backend = new MacOsKeychainBackend((args, options) => {
      calls.push({ args, ...options });
      return "";
    });

    backend.set("dev.symphony.test", "fixture-user", LEGACY_SECRET);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.args).not.toContain(LEGACY_SECRET);
    expect(calls[0]?.input).not.toContain(LEGACY_SECRET);
    expect(calls[0]?.input).toContain(`-X '${Buffer.from(LEGACY_SECRET, "utf8").toString("hex")}'`);
    expect(calls[0]).toMatchObject({ output: "ignore", timeoutMs: 5_000 });
  });

  it("quotes interactive account and service fields and rejects unsafe line framing", () => {
    const inputs: string[] = [];
    const backend = new MacOsKeychainBackend((_args, options) => {
      if (options.input) inputs.push(options.input);
      return "";
    });

    backend.set("service with 'quotes' and \\slashes", "account with 'quotes' and \\slashes", "fixture");

    expect(inputs).toEqual([
      `add-generic-password -U -a 'account with \\'quotes\\' and \\\\slashes' -s 'service with \\'quotes\\' and \\\\slashes' -X '${Buffer.from("fixture", "utf8").toString("hex")}'\n`,
    ]);
    expect(() => backend.set("service\ncommand", "account", "fixture")).toThrow("unsupported control character");
    expect(() => backend.set("service", "account\rcommand", "fixture")).toThrow("unsupported control character");
    expect(() => backend.set("service", "account\0command", "fixture")).toThrow("unsupported control character");
    expect(inputs).toHaveLength(1);
  });

  it("bounds every Keychain operation and removes only the CLI line ending from reads", () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const backend = new MacOsKeychainBackend((args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      return args[0] === "find-generic-password" ? 'password: "  padded generic secret  "\n' : "";
    });

    expect(backend.get("service", "account")).toBe("  padded generic secret  ");
    backend.set("service", "account", "  padded generic secret  ");
    expect(backend.delete("service", "account")).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.timeoutMs === 5_000)).toBe(true);
    expect(() => backend.set("service", "account", "x".repeat(2_100))).toThrow("exceeds the supported length");
    expect(calls).toHaveLength(3);
  });

  it("decodes SecurityTool's hex representation for arbitrary UTF-8 secret text", () => {
    const secret = "café\twith a trailing newline\n";
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const backend = new MacOsKeychainBackend((args) => (
      args[0] === "find-generic-password"
        ? `password: 0x${hex}  "escaped presentation is ignored"\n`
        : ""
    ));

    expect(backend.get("service", "account")).toBe(secret);
  });

  it.runIf(process.platform === "darwin")(
    "round-trips through a disposable Keychain without changing the user search list",
    () => {
      const root = mkdtempSync(join(tmpdir(), "symphony-keychain-integration-"));
      temporary.push(root);
      const keychainPath = join(root, "transport fixture.keychain-db");
      const runSecurity = (args: string[], output: "capture" | "ignore" = "ignore"): string => execFileSync(
        "/usr/bin/security",
        args,
        {
          encoding: "utf8",
          stdio: ["ignore", output === "capture" ? "pipe" : "ignore", "ignore"],
          timeout: 5_000,
          killSignal: "SIGKILL",
        },
      );
      const searchListBefore = runSecurity(["list-keychains", "-d", "user"], "capture");
      runSecurity(["create-keychain", "-p", "", keychainPath]);
      try {
        runSecurity(["unlock-keychain", "-p", "", keychainPath]);
        const backend = new MacOsKeychainBackend(undefined, keychainPath);
        const secrets = new SecretStore("dev.symphony integration 'quote' \\ slash", {
          platform: "darwin",
          environment: {},
          nativeBackend: backend,
          account: "fixture account 'quote' \\ slash",
        });
        const secret = randomBytes(32).toString("hex");

        secrets.set("roundtrip", secret);
        const readBack = secrets.get("roundtrip");
        const exact = readBack !== null
          && Buffer.byteLength(readBack) === Buffer.byteLength(secret)
          && timingSafeEqual(Buffer.from(readBack), Buffer.from(secret));
        expect(exact).toBe(true);
        const updatedSecret = `  ${randomBytes(16).toString("hex")}  `;
        secrets.set("roundtrip", updatedSecret);
        const updatedReadBack = secrets.get("roundtrip");
        const updatedExact = updatedReadBack !== null
          && Buffer.byteLength(updatedReadBack) === Buffer.byteLength(updatedSecret)
          && timingSafeEqual(Buffer.from(updatedReadBack), Buffer.from(updatedSecret));
        expect(updatedExact).toBe(true);
        const arbitraryUtf8Secret = `café\t${randomBytes(8).toString("hex")}\n`;
        secrets.set("roundtrip", arbitraryUtf8Secret);
        const arbitraryReadBack = secrets.get("roundtrip");
        const arbitraryExact = arbitraryReadBack !== null
          && Buffer.byteLength(arbitraryReadBack) === Buffer.byteLength(arbitraryUtf8Secret)
          && timingSafeEqual(Buffer.from(arbitraryReadBack), Buffer.from(arbitraryUtf8Secret));
        expect(arbitraryExact).toBe(true);
        expect(secrets.delete("roundtrip")).toBe(true);
        expect(secrets.get("roundtrip")).toBeNull();
      } finally {
        runSecurity(["delete-keychain", keychainPath]);
      }
      expect(runSecurity(["list-keychains", "-d", "user"], "capture")).toBe(searchListBefore);
    },
  );

  it("reserves the complete scoped daemon-secret namespace from generic CLI handling", () => {
    expect(isDaemonSecretKey("daemon.secret")).toBe(true);
    expect(isDaemonSecretKey("daemon.secret.credential.g1")).toBe(true);
    expect(isDaemonSecretKey("openrouter.apiKey")).toBe(false);
  });

  it("removes only the daemon root from child process environments", () => {
    const parent = {
      SYMPHONY_DAEMON_SECRET: LEGACY_SECRET,
      Symphony_Daemon_Secret: EXTERNAL_SECRET,
      SYMPHONY_AGENT_TOKEN: "retained-agent-token",
      PATH: "/fixture/bin",
    };

    expect(environmentWithoutDaemonSecret(parent)).toEqual({
      SYMPHONY_AGENT_TOKEN: "retained-agent-token",
      PATH: "/fixture/bin",
    });
    expect(parent.SYMPHONY_DAEMON_SECRET).toBe(LEGACY_SECRET);
  });
});
