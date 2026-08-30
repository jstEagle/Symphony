import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "@symphony/config";
import type { SymphonyStore } from "@symphony/storage";

export const LEGACY_DAEMON_SECRET_METADATA_KEY = "daemon-secret";
export const DAEMON_CREDENTIAL_ID_METADATA_KEY = "daemon-credential-id";
export const DAEMON_CREDENTIAL_GENERATION_METADATA_KEY = "daemon-credential-generation";
export const DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY = "daemon-credential-fingerprint";

const DAEMON_SECRET_PATTERN = /^[0-9a-f]{64}$/u;

export type DaemonCredential = {
  secret: string;
  credentialId: string;
  generation: number;
  fingerprint: string;
  state: "external" | "legacy-migrated" | "legacy-compatibility";
  location: string;
  allowNewCredentials: boolean;
};

export type DaemonCredentialResolverOptions = {
  platform?: NodeJS.Platform;
  randomSecret?: () => string;
  randomCredentialId?: () => string;
};

function daemonSecretKey(credentialId: string, generation: number): string {
  return `daemon.secret.${credentialId}.g${generation}`;
}

function requireSecret(value: string, source: string): string {
  if (!DAEMON_SECRET_PATTERN.test(value)) {
    throw new Error(`${source} must contain exactly 32 bytes encoded as 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function daemonCredentialFingerprint(secret: string): string {
  return createHash("sha256")
    .update("symphony-daemon-credential:v1\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

function metadataString(store: SymphonyStore, key: string): string | null {
  if (!store.hasMetadata(key)) return null;
  const value = store.getMetadata(key);
  if (typeof value !== "string" || !value.length) throw new Error(`Invalid ${key} metadata.`);
  return value;
}

function metadataGeneration(store: SymphonyStore): number {
  if (!store.hasMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY)) return 1;
  const value = store.getMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY);
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Invalid ${DAEMON_CREDENTIAL_GENERATION_METADATA_KEY} metadata.`);
  }
  return value as number;
}

export function resolveDaemonCredential(
  store: SymphonyStore,
  secrets: Pick<SecretStore, "get" | "set" | "describeLocation">,
  options: DaemonCredentialResolverOptions = {},
): DaemonCredential {
  const platform = options.platform ?? process.platform;
  const legacyValue = metadataString(store, LEGACY_DAEMON_SECRET_METADATA_KEY);
  const legacySecret = legacyValue === null ? null : requireSecret(legacyValue, "Legacy daemon credential");
  const previousFingerprintValue = metadataString(store, DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY);
  const previousFingerprint = previousFingerprintValue === null
    ? null
    : requireSecret(previousFingerprintValue, "Durable daemon credential fingerprint");
  if (
    legacySecret
    && previousFingerprint
    && !safeEqual(previousFingerprint, daemonCredentialFingerprint(legacySecret))
  ) {
    throw new Error("The legacy daemon credential does not match the durable credential fingerprint. Restore the matching credential state before recovery.");
  }
  const credentialId = metadataString(store, DAEMON_CREDENTIAL_ID_METADATA_KEY)
    ?? (options.randomCredentialId ?? randomUUID)();
  const generation = metadataGeneration(store);

  store.transaction(() => {
    if (!store.hasMetadata(DAEMON_CREDENTIAL_ID_METADATA_KEY)) {
      store.setMetadata(DAEMON_CREDENTIAL_ID_METADATA_KEY, credentialId);
    }
    if (!store.hasMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY)) {
      store.setMetadata(DAEMON_CREDENTIAL_GENERATION_METADATA_KEY, generation);
    }
  });

  const key = daemonSecretKey(credentialId, generation);
  const externalValue = secrets.get(key);
  const externalSecret = externalValue && DAEMON_SECRET_PATTERN.test(externalValue) ? externalValue : null;
  let secret: string;
  let state: DaemonCredential["state"];
  let allowNewCredentials = true;

  if (legacySecret) {
    if (externalSecret && safeEqual(externalSecret, legacySecret)) {
      secret = legacySecret;
      state = "external";
    } else if (!externalValue && platform === "darwin") {
      let readBack: string | null = null;
      try {
        secrets.set(key, legacySecret);
        readBack = secrets.get(key);
      } catch {
        // A locked or unavailable login keychain must not strand retained
        // workers. The exact SQLite value remains the Release 1 rollback
        // shadow, while compatibility mode prevents minting new dependants.
      }
      if (readBack && safeEqual(readBack, legacySecret)) {
        secret = legacySecret;
        state = "legacy-migrated";
      } else {
        secret = legacySecret;
        state = "legacy-compatibility";
        allowNewCredentials = false;
      }
    } else {
      // Headless environments cannot write their parent environment, and an
      // unexpected external value may be a pending rotation. Keep the exact
      // legacy key for existing tokens and retained host capabilities, but do
      // not mint additional dependants until an operator resolves the state.
      secret = legacySecret;
      state = "legacy-compatibility";
      allowNewCredentials = false;
    }
  } else if (externalValue) {
    secret = requireSecret(externalValue, "External daemon credential");
    state = "external";
  } else if (platform === "darwin") {
    if (previousFingerprint) {
      throw new Error("The external daemon credential is unavailable. Unlock Keychain or restore the previous secret before recovery.");
    }
    secret = (options.randomSecret ?? (() => randomBytes(32).toString("hex")))();
    requireSecret(secret, "Generated daemon credential");
    secrets.set(key, secret);
    const readBack = secrets.get(key);
    if (!readBack || !safeEqual(readBack, secret)) {
      throw new Error("The generated daemon credential could not be verified in macOS Keychain.");
    }
    state = "external";
  } else {
    throw new Error("SYMPHONY_DAEMON_SECRET is required when no macOS Keychain adapter or legacy daemon credential is available.");
  }

  const fingerprint = daemonCredentialFingerprint(secret);
  if (previousFingerprint && !safeEqual(previousFingerprint, fingerprint)) {
    throw new Error("The resolved daemon credential does not match the durable credential fingerprint. Restore the previous external secret before recovery.");
  }
  if (!previousFingerprint) store.setMetadata(DAEMON_CREDENTIAL_FINGERPRINT_METADATA_KEY, fingerprint);

  return {
    secret,
    credentialId,
    generation,
    fingerprint,
    state,
    location: state === "legacy-compatibility" ? "legacy-sqlite" : secrets.describeLocation(key),
    allowNewCredentials,
  };
}
