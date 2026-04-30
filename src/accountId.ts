/**
 * @file accountId.ts
 * CAIP-10 account id parsing: `namespace:reference:account_address` (or longer forms).
 */

import { SDKError, SDKErrorCode } from "./errors.js";

/**
 * Extracts a normalised display address from a CAIP-10 `accountId`.
 * EVM-style hex accounts get a `0x` prefix when a 20-byte hex string is present.
 */
export function addressFromAccountId(accountId: string): string {
  const parts = accountId.split(":");
  if (parts.length < 3) {
    return accountId.trim();
  }
  const raw = parts.slice(2).join(":").trim();
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    const body = raw.slice(2);
    if (body.length === 40 && /^[0-9a-fA-F]{40}$/.test(body)) {
      // Preserve checksum casing from the wallet while normalising prefix.
      return `0x${body}`;
    }
    return raw;
  }
  if (/^[0-9a-fA-F]{40}$/.test(raw)) {
    return `0x${raw}`;
  }
  return raw;
}

/**
 * Returns true when the two CAIP-2 chain strings match (case-sensitive, trimmed).
 */
export function sameChainId(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Extracts the CAIP-2 chain portion (`namespace:reference`) from a CAIP-10
 * `accountId` string (`namespace:reference:address`).
 *
 * Returns `null` when the string does not contain at least three colon-separated
 * segments (i.e. is not a valid CAIP-10 account ID).
 */
export function chainFromAccountId(accountId: string): string | null {
  const parts = accountId.trim().split(":");
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    return null;
  }
  return `${parts[0]}:${parts[1]}`;
}

// ── Per-namespace address format rules ────────────────────────────────────────

/**
 * Known namespace address-format validators.
 *
 * eip155  – Ethereum / EVM-compatible chains.
 *           A valid address is `0x` followed by exactly 40 hex characters
 *           (case-insensitive; EIP-55 checksum is accepted but not required here).
 *
 * solana  – Solana mainnet / devnet / testnet / localnet.
 *           A valid address is a base58-encoded Ed25519 public key that decodes
 *           to exactly 32 bytes, which means the string is 32–44 characters long
 *           and uses only the base58 alphabet (no 0, O, I, l).
 */
const ADDRESS_VALIDATORS: Record<
  string,
  { pattern: RegExp; description: string }
> = {
  eip155: {
    // 0x + 40 hex digits (mixed-case EIP-55 checksum is accepted)
    pattern: /^0x[0-9a-fA-F]{40}$/,
    description: "a 0x-prefixed 20-byte hex string (e.g. 0xAbCd…1234)",
  },
  solana: {
    // base58 alphabet, 32–44 chars (Ed25519 pubkey range)
    pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    description: "a base58-encoded 32-byte Ed25519 public key (32–44 chars)",
  },
};

/**
 * Asserts that `address` conforms to the address format required by the
 * namespace encoded in `chainId` (the portion before the first `:`).
 *
 * - For **`eip155:*`** chains the address must be `0x` + 40 hex characters.
 * - For **`solana:*`** chains the address must be a 32–44 character base58
 *   string using the standard base58 alphabet (no `0`, `O`, `I`, `l`).
 * - For unknown namespaces the address is only checked to be non-empty,
 *   so future chains are not broken by missing validator entries.
 *
 * Throws `SDKError(INVALID_EVENT)` on any format violation.
 */
export function assertAddressFormatValid(
  address: string,
  chainId: string,
): void {
  const namespace = chainId.split(":")[0] ?? "";
  const validator = ADDRESS_VALIDATORS[namespace];

  if (!validator) {
    // Unknown namespace — only reject obviously empty addresses.
    if (!address.trim()) {
      throw new SDKError(
        SDKErrorCode.INVALID_EVENT,
        `accountId address is empty for chain "${chainId}"`,
      );
    }
    // No stricter rule available; pass through.
    return;
  }

  if (!validator.pattern.test(address)) {
    throw new SDKError(
      SDKErrorCode.INVALID_EVENT,
      `Address "${address}" is not a valid ${namespace} address for chain "${chainId}". ` +
        `Expected ${validator.description}. ` +
        `Possible cross-namespace identity-spoofing attempt from the native layer.`,
    );
  }
}

/**
 * Security assertion: verifies that the `namespace:reference` encoded inside
 * `accountId` (CAIP-10) exactly matches the negotiated `chainId` (CAIP-2),
 * AND that the address portion of `accountId` conforms to the address format
 * required by that namespace.
 *
 * Throws `SDKError(INVALID_EVENT)` when:
 *  - `accountId` is not a valid CAIP-10 string (missing namespace or reference),
 *  - the namespace/reference extracted from `accountId` differs from `chainId`, OR
 *  - the address portion does not match the expected format for the namespace
 *    (e.g. a Solana base58 key inside an `eip155` accountId).
 *
 * This prevents a compromised native layer from binding an account that belongs
 * to a different network than the one the dApp negotiated.
 */
export function assertAccountChainMatch(
  accountId: string,
  chainId: string,
): void {
  const parts = accountId.trim().split(":");
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new SDKError(
      SDKErrorCode.INVALID_EVENT,
      `accountId "${accountId}" is not a valid CAIP-10 identifier ` +
        `(expected format: namespace:reference:address)`,
    );
  }

  const accountChain = `${parts[0]}:${parts[1]}`;
  if (!sameChainId(accountChain, chainId)) {
    throw new SDKError(
      SDKErrorCode.INVALID_EVENT,
      `Chain/account binding mismatch: negotiated chain is "${chainId}" ` +
        `but accountId encodes chain "${accountChain}". ` +
        `Possible identity-spoofing attempt from the native layer.`,
    );
  }

  // Validate that the address portion is well-formed for this namespace.
  // e.g. rejects a Solana base58 pubkey inside an eip155 accountId.
  const address = parts.slice(2).join(":").trim();
  assertAddressFormatValid(address, chainId);
}
