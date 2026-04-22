/**
 * @file errors.ts
 * Typed error class for the Outlaw Wallet SDK.
 */

export const enum SDKErrorCode {
  // ── Connection ──────────────────────────────────────────────────────────────
  NOT_CONNECTED = "NOT_CONNECTED",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  // ── Request lifecycle ───────────────────────────────────────────────────────
  TIMEOUT = "TIMEOUT",
  USER_REJECTED = "USER_REJECTED",
  // ── Crypto ─────────────────────────────────────────────────────────────────
  ENCRYPTION_FAILED = "ENCRYPTION_FAILED",
  // ── Transport ──────────────────────────────────────────────────────────────
  INVALID_ORIGIN = "INVALID_ORIGIN",
  INVALID_EVENT = "INVALID_EVENT",
  // ── Config / chain policy ───────────────────────────────────────────────────
  INVALID_CONFIG = "INVALID_CONFIG",
  /** Requested `chainId` is not in the constructor `chains` allow-list. */
  CHAIN_NOT_ALLOWED = "CHAIN_NOT_ALLOWED",
  // ── Input payload ───────────────────────────────────────────────────────────
  INVALID_PAYLOAD = "INVALID_PAYLOAD",
}

export class SDKError extends Error {
  public readonly code: SDKErrorCode;

  constructor(code: SDKErrorCode, message: string) {
    super(message);
    this.name = "SDKError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public isNotConnected(): boolean {
    return this.code === SDKErrorCode.NOT_CONNECTED;
  }

  public isTimeout(): boolean {
    return this.code === SDKErrorCode.TIMEOUT;
  }

  public isUserRejection(): boolean {
    return this.code === SDKErrorCode.USER_REJECTED;
  }

  public override toString(): string {
    return `SDKError[${this.code}]: ${this.message}`;
  }
}

export function isSdkError(err: unknown): err is SDKError {
  return err instanceof SDKError;
}
