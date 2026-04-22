/**
 * @file accountId.ts
 * CAIP-10 account id parsing: `namespace:reference:account_address` (or longer forms).
 */

/**
 * Extracts a normalised display address from a CAIP-10 `accountId`.
 * EVM-style hex accounts get a `0x` prefix when a 20-byte hex string is present.
 */
export function addressFromAccountId(accountId: string): string {
  const parts = accountId.split(":");
  if (parts.length < 3) {
    return accountId.trim();
  }
  const raw = parts.slice(2).join(":");
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    const body = raw.slice(2);
    if (body.length === 40 && /^[0-9a-fA-F]{40}$/.test(body)) {
      return `0x${body.toLowerCase()}`;
    }
    return raw;
  }
  if (/^[0-9a-fA-F]{40}$/.test(raw)) {
    return `0x${raw.toLowerCase()}`;
  }
  return raw;
}

/**
 * Returns true when the two CAIP-2 chain strings match (case-sensitive, trimmed).
 */
export function sameChainId(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
