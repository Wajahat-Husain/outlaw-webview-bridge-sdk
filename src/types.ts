/**
 * @file types.ts
 * All public-facing types for the Outlaw WebView Wallet SDK.
 *
 * Design principle: only model what actually exists in the native protocol.
 * Three events in. Three methods out.
 */
import type { Transaction } from "@solana/web3.js";

// ─── Connection / session (dApp-facing) ───────────────────────────────────────

/**
 * Snapshot returned by `sdk.connect()` and `sdk.getSession()`.
 *
 * The encryption key (`sessionId` from the native wallet) is **never** exposed
 * here — it stays inside the SDK instance.
 */
export interface Session {
  /** Display / signing address (derived from the CAIP-10 `accountId`). */
  readonly address: string;
  /** CAIP-2 chain identifier, e.g. `"solana:devnet"` or `"eip155:1"`. */
  readonly chainId: string;
  /** Always `true` when this object is returned from a successful `connect()`. */
  readonly connected: true;
  /** Epoch timestamp (ms) when the session ceases to be valid for signing. */
  readonly expiresAt: number;
}

/**
 * One-shot account + connection summary for dApp UI guards.
 */
export interface AccountInfo {
  readonly address: string | null;
  readonly isConnected: boolean;
  /** `<chainId>:<address>` when connected, else `null`. */
  readonly caipAddress: string | null;
  readonly status: "connected" | "disconnected";
}

// ─── Signature Results ────────────────────────────────────────────────────────

export type WalletResponse =
  | { signature: string } // Used for message signing (Solana + EVM)
  | { hash: string }; // Used for transaction result (EVM tx hash)

// ─── Solana Payloads ───────────────────────────────────────────────────────────

export interface SolanaSignMessagePayload {
  /** The message to sign, as UTF-8 text or raw bytes. */
  readonly message: string | Uint8Array;
}

export interface SolanaTransactionPayload {
  /** Solana transaction to sign/send. */
  readonly transaction: Transaction;
}

// ─── EVM Payloads ──────────────────────────────────────────────────────────────

export interface EVMSignMessagePayload {
  readonly message: string; // hex string preferred by many wallets
}

export interface EVMTransactionPayload {
  readonly from?: string;
  readonly to?: string;
  readonly value?: string;
  readonly data?: string;
  readonly gasLimit?: string;
  readonly gasPrice?: string;
  readonly nonce?: string;
}

// ─── Sign & Send Transaction (transport-level) ────────────────────────────────

export interface SignAndSendTransactionPayload {
  /** Base64-encoded serialized transaction (Solana Transaction or VersionedTransaction). */
  readonly encodedTransaction: string;
  readonly options?: {
    readonly encoding?: "base64";
    readonly skipPreflight?: boolean;
    readonly preflightCommitment?: "processed" | "confirmed" | "finalized";
  };
}

// ─── SDK Config ───────────────────────────────────────────────────────────────

export interface WalletSDKConfig {
  /**
   * Origin of the native wallet's postMessage source.
   * Auto-detected from `document.referrer` or `?walletOrigin=` query param
   * when omitted. Provide explicitly in production for maximum security.
   */
  readonly walletOrigin?: string | undefined;
  /**
   * Target window to postMessage to (default: `window.parent`).
   * Override for popup-style wallet integrations.
   */
  readonly targetWindow?: Window | undefined;
  /**
   * dApp metadata shown in the wallet's approval UI.
   */
  readonly dapp: DAppInfo;
  /**
   * CAIP-2 chain identifiers the dApp wants to use.
   * e.g. ["solana:devnet"] or ["solana:mainnet-beta", "eip155:1"]
   */
  readonly chains: readonly string[];
  /**
   * How long to wait for a native response before rejecting (ms).
   * Default: 30 000
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Print debug logs to the console. Default: false.
   */
  readonly debug?: boolean | undefined;
  /**
   * Session lifetime after a successful `connect()` (ms). Default: 24 hours.
   */
  readonly sessionTtlMs?: number | undefined;
  /**
   * When `true` (default), a minimal session snapshot is stored in
   * `sessionStorage` so a full page reload can skip a second native session
   * handshake for the same tab. Disable for stricter XSS threat models.
   */
  readonly persistSession?: boolean | undefined;
  /**
   * Optional custom JSON-RPC / HTTP Solana endpoint per CAIP-2 id, overriding
   * the SDK’s built-in defaults.
   */
  readonly chainRpcOverrides?: Readonly<Record<string, string>> | undefined;
}

export interface DAppInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly url: string;
  readonly icon?: string | undefined;
}

// ─── Native Events (internal — not exposed to dApp) ──────────────────────────

/**
 * Shape of the `onWalletSession` DOM event detail.
 * Emitted by the native layer after `wallet_createSession` is processed.
 */
export interface NativeSessionEvent {
  readonly id: string;
  readonly sessionId: string; // encrypted public key
  readonly chainId: string;
  readonly accountId: string;
}

/**
 * Shape of `signAndSendTransactionResponse` and `signMessageResponse` event detail.
 */
export type NativeSignatureEvent = { signature: string } | { hash: string };

/**
 * Shape of `onRejectResponse` event detail.
 * Emitted by the native layer when the user rejects an operation.
 */
export interface NativeRejectEvent {
  readonly status?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly code?: string | number;
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/** Result of encrypting a payload with the session's public key. */
export interface EncryptedPayload {
  readonly encryptedKey: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

// ─── JSON-RPC primitives (internal) ──────────────────────────────────────────

export type JsonRpcId = string;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}
