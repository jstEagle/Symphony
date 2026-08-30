import { readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { environmentWithoutDaemonSecret } from "@symphony/config";
import { nowIso, type ProcessIdentity } from "@symphony/protocol";

export type ProcessIdentityInspection =
  | { status: "dead"; detail: string }
  | { status: "exact"; identity: ProcessIdentity; detail: string }
  | { status: "mismatch"; identity: ProcessIdentity; detail: string }
  | { status: "unverified"; identity: ProcessIdentity | null; detail: string };

/**
 * Capture the strongest process-birth identity the host exposes cheaply.
 * Linux gives us a boot-scoped start token. Darwin's `ps` timestamp is useful
 * evidence for people, but deliberately remains weak and must never authorize
 * cross-generation signalling.
 */
export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return null;
  if (process.platform === "linux") return captureLinuxIdentity(pid);
  if (process.platform === "darwin") return captureDarwinIdentity(pid);
  return {
    pid,
    processGroupId: processGroupId(pid),
    platform: process.platform,
    capturedAt: nowIso(),
    executable: null,
    startToken: null,
    verification: "unverified",
  };
}

export function inspectProcessIdentity(expected: ProcessIdentity): ProcessIdentityInspection {
  if (!processExists(expected.pid)) {
    return { status: "dead", detail: `PID ${expected.pid} no longer exists.` };
  }
  const current = captureProcessIdentity(expected.pid);
  if (!current) {
    return { status: "unverified", identity: null, detail: `PID ${expected.pid} exists but its identity could not be read.` };
  }
  if (expected.verification !== "strong" || current.verification !== "strong") {
    return {
      status: "unverified",
      identity: current,
      detail: `PID ${expected.pid} is live, but ${process.platform} did not provide strong process-birth evidence.`,
    };
  }
  const sameBirth = expected.startToken !== null && expected.startToken === current.startToken;
  const sameExecutable = expected.executable === null || current.executable === expected.executable;
  const sameGroup = expected.processGroupId === null || current.processGroupId === expected.processGroupId;
  if (sameBirth && sameExecutable && sameGroup) {
    return { status: "exact", identity: current, detail: `PID ${expected.pid} matches its recorded birth identity.` };
  }
  return {
    status: "mismatch",
    identity: current,
    detail: `PID ${expected.pid} is live but no longer matches its recorded birth identity or process group.`,
  };
}

function captureLinuxIdentity(pid: number): ProcessIdentity {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) throw new Error("Malformed proc stat");
    // Fields after the command begin at field 3. starttime is field 22.
    const fields = stat.slice(closeParen + 2).split(/\s+/u);
    const startTicks = fields[19];
    if (!bootId || !startTicks) throw new Error("Missing Linux process birth token");
    let executable: string | null = null;
    try {
      executable = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // A readable birth token is enough; executable is additional evidence.
    }
    return {
      pid,
      processGroupId: processGroupId(pid),
      platform: process.platform,
      capturedAt: nowIso(),
      executable,
      startToken: `${bootId}:${startTicks}`,
      verification: "strong",
    };
  } catch {
    return {
      pid,
      processGroupId: processGroupId(pid),
      platform: process.platform,
      capturedAt: nowIso(),
      executable: commandFor(pid),
      startToken: null,
      verification: "unverified",
    };
  }
}

function captureDarwinIdentity(pid: number): ProcessIdentity {
  return {
    pid,
    processGroupId: processGroupId(pid),
    platform: process.platform,
    capturedAt: nowIso(),
    executable: commandFor(pid),
    startToken: psValue(pid, "lstart"),
    verification: "weak",
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processGroupId(pid: number): number | null {
  const raw = psValue(pid, "pgid");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function commandFor(pid: number): string | null {
  return psValue(pid, "command");
}

function psValue(pid: number, field: string): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    env: environmentWithoutDaemonSecret(),
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}
