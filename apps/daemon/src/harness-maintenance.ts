import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { environmentWithoutDaemonSecret, type LoadedConfig } from "@symphony/config";
import type { DriverDoctorResult, ResolvedHarness } from "@symphony/protocol";
import type { DriverRegistry } from "@symphony/drivers";

const execFileAsync = promisify(execFile);
type MaintainedHarness = "codex" | "claude" | "cursor" | "opencode" | "pi";
type LatestCache = { checkedAt: number; version: string | null };

export class HarnessMaintenance {
  private readonly latest = new Map<MaintainedHarness, LatestCache>();

  constructor(private readonly loaded: LoadedConfig, private readonly drivers: DriverRegistry) {}

  async reports(forceLatest = false): Promise<DriverDoctorResult[]> {
    return await Promise.all(this.drivers.list().map(async (driver) => await this.report(driver.id, forceLatest)));
  }

  async report(id: ResolvedHarness, forceLatest = false): Promise<DriverDoctorResult> {
    const driver = this.drivers.get(id);
    const report = await driver.doctor();
    if (!isMaintained(id)) {
      return {
        ...report,
        updateSupported: false,
        updateAvailable: null,
        latestVersion: null,
        checkedAt: new Date().toISOString(),
      };
    }
    return await this.enrich(id, report, forceLatest);
  }

  async update(id: ResolvedHarness): Promise<{ report: DriverDoctorResult; output: string }> {
    if (!isMaintained(id)) throw new Error(`${id} does not have a configured updater.`);
    const update = this.loaded.config.harnessUpdates.harnesses[id];
    if (!update) throw new Error(`${id} does not have a configured updater.`);
    const executable = await commandPath(update.command);
    if (id === "codex" && executable?.includes("/Applications/ChatGPT.app/")) {
      throw new Error("This Codex CLI is bundled with ChatGPT and is updated with the desktop app.");
    }
    const result = await execFileAsync(update.command, update.args, {
      cwd: this.loaded.rootDirectory,
      env: environmentWithoutDaemonSecret(),
      timeout: 5 * 60_000,
      maxBuffer: 2_000_000,
    });
    this.latest.delete(id);
    const report = await this.enrich(id, await this.drivers.get(id).doctor(), true);
    return { report, output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
  }

  private async enrich(id: MaintainedHarness, report: DriverDoctorResult, forceLatest: boolean): Promise<DriverDoctorResult> {
    const update = this.loaded.config.harnessUpdates.harnesses[id];
    const probed = report.version ?? await probeVersion(this.loaded.config.harnesses[id].process.command);
    const installedVersion = extractCliVersion(probed);
    const executable = update ? await commandPath(update.command) : null;
    const appManaged = id === "codex" && Boolean(executable?.includes("/Applications/ChatGPT.app/"));
    const latestVersion = update && report.available ? await this.latestVersion(id, forceLatest) : null;
    const updateAvailable = installedVersion && latestVersion ? compareCliVersions(latestVersion, installedVersion) > 0 : null;
    return {
      ...report,
      version: installedVersion,
      latestVersion: appManaged ? installedVersion : latestVersion,
      updateAvailable: appManaged ? false : updateAvailable,
      updateSupported: Boolean(update && report.available && !appManaged),
      updateDetail: appManaged
        ? "Managed by the ChatGPT desktop app."
        : updateAvailable === true
          ? `${latestVersion} is available.`
          : updateAvailable === false
            ? "Up to date."
            : "Latest-version check unavailable.",
      checkedAt: new Date().toISOString(),
    };
  }

  private async latestVersion(id: MaintainedHarness, force: boolean): Promise<string | null> {
    const cached = this.latest.get(id);
    const maxAge = this.loaded.config.harnessUpdates.checkIntervalMinutes * 60_000;
    if (!force && cached && Date.now() - cached.checkedAt < maxAge) return cached.version;
    const source = this.loaded.config.harnessUpdates.harnesses[id]?.latest;
    let version: string | null = null;
    try {
      if (source?.source === "npm") {
        const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(source.packageName)}/latest`, { signal: AbortSignal.timeout(8_000) });
        if (response.ok) version = extractCliVersion((await response.json() as { version?: unknown }).version);
      } else if (source?.source === "installer") {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(8_000) });
        if (response.ok) version = extractCliVersion(new RegExp(source.versionPattern, "u").exec(await response.text())?.[1]);
      }
    } catch {
      version = null;
    }
    this.latest.set(id, { checkedAt: Date.now(), version });
    return version;
  }
}

function isMaintained(id: ResolvedHarness): id is MaintainedHarness {
  return ["codex", "claude", "cursor", "opencode", "pi"].includes(id);
}

async function commandPath(command: string): Promise<string | null> {
  if (command.includes("/")) return command;
  try {
    return (await execFileAsync("which", [command], { timeout: 3_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function probeVersion(command: string): Promise<string | null> {
  try {
    return (await execFileAsync(command, ["--version"], { timeout: 3_000 })).stdout.trim().split(/\r?\n/u)[0] ?? null;
  } catch {
    return null;
  }
}

export function extractCliVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?/u)?.[0] ?? (value.trim() || null);
}

export function compareCliVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = "0", suffix] = value.split("-", 2);
    return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease: suffix !== undefined };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return left.localeCompare(right);
}
