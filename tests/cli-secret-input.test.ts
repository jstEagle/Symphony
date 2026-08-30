import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseSecretInputSource,
  readSecretInput,
  type SecretInputReader,
} from "../apps/cli/src/secret-input.js";

function reader(input: string, stdinIsTty = false): SecretInputReader {
  return {
    stdinIsTty,
    readStdin: () => input,
    readFile: () => input,
  };
}

describe("CLI secret input", () => {
  it("rejects legacy positional values with migration guidance without echoing the secret", () => {
    const value = "must-not-appear-in-errors";
    let error: Error | null = null;
    try {
      parseSecretInputSource([value]);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain("not accepted as positional arguments");
    expect(error?.message).toContain("--stdin");
    expect(error?.message).toContain("--file");
    expect(error?.message).not.toContain(value);
  });

  it("requires exactly one explicit secure source", () => {
    expect(() => parseSecretInputSource([])).toThrow("Choose exactly one secure input source");
    expect(() => parseSecretInputSource(["--stdin", "--file", "secret.txt"])).toThrow("Choose exactly one secure input source");
    expect(parseSecretInputSource(["--stdin"])).toEqual({ kind: "stdin" });
    expect(parseSecretInputSource(["--file", "secret.txt"])).toEqual({ kind: "file", path: "secret.txt" });
  });

  it("removes exactly one pipeline line ending and preserves every other character", () => {
    expect(readSecretInput({ kind: "stdin" }, reader("  padded secret  \n"))).toBe("  padded secret  ");
    expect(readSecretInput({ kind: "stdin" }, reader("line\n\n"))).toBe("line\n");
    expect(readSecretInput({ kind: "stdin" }, reader("line\r\n"))).toBe("line");
    expect(readSecretInput({ kind: "stdin" }, reader("line\r"))).toBe("line\r");
  });

  it("refuses an interactive stdin before reading and rejects empty input", () => {
    const readStdin = vi.fn(() => "secret");
    expect(() => readSecretInput({ kind: "stdin" }, {
      stdinIsTty: true,
      readStdin,
      readFile: () => "",
    })).toThrow("Refusing to read a secret from an interactive terminal");
    expect(readStdin).not.toHaveBeenCalled();
    expect(() => readSecretInput({ kind: "stdin" }, reader("\n"))).toThrow("supplied secret is empty");
  });

  it("reads file input exactly, including trailing newlines", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-cli-secret-"));
    const path = join(directory, "credential");
    try {
      writeFileSync(path, "  exact file secret\n", { mode: 0o600 });
      expect(readSecretInput({ kind: "file", path })).toBe("  exact file secret\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
