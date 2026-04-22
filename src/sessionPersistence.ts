/**
 * @file sessionPersistence.ts
 * Optional tab-scoped `sessionStorage` snapshot so dApps can survive full reloads
 * without forcing the user through another native `wallet_createSession` round-trip.
 *
 * Security: anything in `sessionStorage` is visible to same-origin script (including
 * any XSS). Do not set `persistSession: true` if your threat model disallows that.
 */

import { SDKError, SDKErrorCode } from "./errors.js";

const SCHEMA_VERSION = 1 as const;

export interface PersistedSessionPayload {
  readonly v: typeof SCHEMA_VERSION;
  readonly sessionId: string;
  readonly chainId: string;
  readonly accountId: string;
  readonly address: string;
  readonly expiresAt: number;
  readonly rpcUrl: string;
  readonly family: "solana" | "evm";
}

function storageKey(fingerprint: string): string {
  return `outlaw.wbsdk.sess.v${SCHEMA_VERSION}::${fingerprint}`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPersistedSession(
  fingerprint: string,
): PersistedSessionPayload | null {
  const st = getSessionStorage();
  if (!st) return null;
  const raw = st.getItem(storageKey(fingerprint));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PersistedSessionPayload;
    if (p.v !== SCHEMA_VERSION) return null;
    if (
      !p.sessionId ||
      !p.chainId ||
      !p.accountId ||
      !p.expiresAt ||
      !p.rpcUrl
    ) {
      return null;
    }
    if (Date.now() >= p.expiresAt) {
      st.removeItem(storageKey(fingerprint));
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

export function savePersistedSession(
  fingerprint: string,
  payload: PersistedSessionPayload,
): void {
  const st = getSessionStorage();
  if (!st) {
    if (typeof window !== "undefined") {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        "sessionStorage is not available; disable persistSession or use a browser environment",
      );
    }
    return;
  }
  st.setItem(storageKey(fingerprint), JSON.stringify(payload));
}

export function clearPersistedSession(fingerprint: string): void {
  const st = getSessionStorage();
  if (!st) return;
  try {
    st.removeItem(storageKey(fingerprint));
  } catch {
    // ignore
  }
}

/**
 * Fingerprint for storage keys: keep stable for the same dApp + allow-list.
 */
export function makeSdkFingerprint(
  dappUrl: string,
  allowedChains: readonly string[],
): string {
  return `${dappUrl.trim()}\0${[...allowedChains]
    .map((c) => c.trim())
    .sort()
    .join("|")}`;
}
