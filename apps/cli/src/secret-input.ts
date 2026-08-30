import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SECRET_SET_USAGE = "Usage: symphony secret set <key> (--stdin | --file <path>)";

export type SecretInputSource =
  | { kind: "stdin" }
  | { kind: "file"; path: string };

export type SecretInputReader = {
  stdinIsTty: boolean;
  readStdin: () => string;
  readFile: (path: string) => string;
};

const defaultReader = (): SecretInputReader => ({
  stdinIsTty: Boolean(process.stdin.isTTY),
  readStdin: () => readFileSync(0, "utf8"),
  readFile: (path) => readFileSync(resolve(path), "utf8"),
});

function positionalSecretError(): Error {
  return new Error(
    "Secret values are not accepted as positional arguments because process arguments may be visible to other local processes. "
    + "Pipe the value to `symphony secret set <key> --stdin`, or use `--file <path>`.",
  );
}

export function parseSecretInputSource(inputArgs: readonly string[]): SecretInputSource {
  if (inputArgs[0] === "--stdin") {
    if (inputArgs.length === 1) return { kind: "stdin" };
    throw new Error(`${SECRET_SET_USAGE}. Choose exactly one secure input source.`);
  }
  if (inputArgs[0] === "--file") {
    if (inputArgs.length === 2 && inputArgs[1]) return { kind: "file", path: inputArgs[1] };
    throw new Error(`${SECRET_SET_USAGE}. Choose exactly one secure input source.`);
  }
  if (inputArgs[0] && !inputArgs[0].startsWith("--")) throw positionalSecretError();
  throw new Error(`${SECRET_SET_USAGE}. Choose exactly one secure input source.`);
}

export function readSecretInput(source: SecretInputSource, reader: SecretInputReader = defaultReader()): string {
  if (source.kind === "stdin" && reader.stdinIsTty) {
    throw new Error("Refusing to read a secret from an interactive terminal. Pipe the value to `--stdin`, or use `--file <path>`.");
  }

  let value = source.kind === "stdin" ? reader.readStdin() : reader.readFile(source.path);
  if (source.kind === "stdin") {
    // A pipeline commonly contributes one record terminator. Remove exactly
    // one, while preserving all other leading/trailing characters. Use
    // --file when a trailing newline is part of the credential itself.
    value = value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
  }
  if (!value.length) throw new Error("The supplied secret is empty.");
  return value;
}
