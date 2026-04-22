/**
 * @file crypto.ts
 * Payload encryption for the Outlaw Wallet SDK.
 *
 * The native wallet provides an RSA public key as `sessionId` (base64-encoded SPKI).
 * We use hybrid RSA-OAEP + AES-GCM encryption: a fresh AES-256-GCM key is
 * generated per request, encrypted with the wallet's RSA public key, and the
 * payload is encrypted with that AES key.
 *
 * Private keys NEVER enter this layer — only public session data is used here.
 */

import { base64ToBytes, bytesToBase64 } from "./encoding.js";
export {
  bytesToBase64 as toBase64,
  base64ToBytes as fromBase64,
} from "./encoding.js";

// ─── UUID ─────────────────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // RFC 4122 v4 fallback
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── Hybrid Encryption ────────────────────────────────────────────────────────

export type HybridEncryptionResult = {
  encryptedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

const RSA_ALGO = "RSA-OAEP";
const AES_ALGO = "AES-GCM";
const AES_KEY_LEN = 256;
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

async function importRsaPublicKey(spkiDer: Uint8Array): Promise<CryptoKey> {
  const keyBuffer = spkiDer.buffer.slice(
    spkiDer.byteOffset,
    spkiDer.byteOffset + spkiDer.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey(
    "spki",
    keyBuffer,
    { name: RSA_ALGO, hash: "SHA-256" },
    false,
    ["encrypt"],
  );
}

/**
 * Encrypts a JSON-serialisable payload using hybrid RSA-OAEP + AES-256-GCM.
 *
 * @param payload              Any JSON-serialisable value
 * @param publicKeyBase64 The wallet's RSA public key (base64 SPKI) from `onWalletSession` — this is the `sessionId`
 */
export async function encryptHybridJson(
  payload: unknown,
  publicKeyBase64: string,
): Promise<HybridEncryptionResult> {
  if (!publicKeyBase64) {
    throw new Error("Missing wallet public key/session id");
  }

  const publicKey = await importRsaPublicKey(base64ToBytes(publicKeyBase64));

  const aesKey = await crypto.subtle.generateKey(
    { name: AES_ALGO, length: AES_KEY_LEN },
    true,
    ["encrypt"],
  );

  const rawAesKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", aesKey),
  );
  const encryptedAesKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: RSA_ALGO }, publicKey, rawAesKey),
  );

  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encryptedBytes = new Uint8Array(
    await crypto.subtle.encrypt({ name: AES_ALGO, iv }, aesKey, plaintext),
  );

  const ciphertext = encryptedBytes.slice(
    0,
    encryptedBytes.length - GCM_TAG_LEN,
  );
  const authTag = encryptedBytes.slice(encryptedBytes.length - GCM_TAG_LEN);

  return {
    encryptedKey: bytesToBase64(encryptedAesKey),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/** @deprecated Use `encryptHybridJson` instead. */
export const encryptPayload = encryptHybridJson;
