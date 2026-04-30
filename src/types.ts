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

// ─── Telemetry (optional) ───────────────────────────────────────────────────

export type WalletSDKTelemetryEvent =
  | {
      readonly type: "connect_latency";
      readonly chainId: string;
      readonly latencyMs: number;
      readonly success: boolean;
    }
  | {
      readonly type: "session_restore";
      readonly chainId: string;
      readonly hit: boolean;
    }
  | {
      readonly type: "timeout";
      readonly operation: "connect" | "signMessage" | "signAndSendTransaction";
      readonly chainId?: string;
      readonly latencyMs: number;
    }
  | {
      readonly type: "rejection";
      readonly operation: "connect" | "signMessage" | "signAndSendTransaction";
      readonly chainId?: string;
      readonly latencyMs: number;
      readonly code?: string;
      readonly message?: string;
    };

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

/**
 * Payload for `eth_signTypedData_v4` (EIP-712), as sent by dApps to the wallet
 * (includes `EIP712Domain` in `types` when the domain is used).
 */
export interface Eip712TypedDataV4 {
  readonly types: Record<
    string,
    ReadonlyArray<{ readonly name: string; readonly type: string }>
  >;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
}

/** Plain UTF-8 / hex message signing, or structured EIP-712 signing. */
export type EVMSignMessagePayload =
  | { readonly message: string }
  | { readonly typedData: Eip712TypedDataV4 };

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
   * Controls runtime validation of resolved RPC endpoints:
   * - `off`: no network probe at `connect()` time (fastest).
   * - `chainIdOnly`: verify EVM `eth_chainId`; skip Solana probe.
   * - `full`: verify EVM `eth_chainId` and perform Solana `getVersion()`.
   *
   * Default: `chainIdOnly`.
   */
  readonly rpcValidation?: "off" | "chainIdOnly" | "full" | undefined;
  /**
   * Security posture for inbound native results:
   * - `legacy` (default): critical results (`connect`, signing) are delivered
   *   via DOM `CustomEvent`s as documented under “Native event contract”.
   * - `strict`: reserved for integrations where the native layer and injected JS
   *   use a correlated bridge (e.g. `WalletBridge` / `OUTLAW_BRIDGE_REQUEST` →
   *   `OUTLAW_BRIDGE_RESPONSE` via `WalletBridge.call()` or equivalent) so that
   *   security-sensitive replies are not accepted from DOM events alone.
   *
   * The current TypeScript SDK still expects legacy DOM events for those flows.
   * Keep `strict` disabled until your app implements that native + JS contract;
   * otherwise `connect` / `signMessage` / `signAndSendTransaction` will fail
   * with `INVALID_CONFIG`.
   */
  readonly securityMode?: "legacy" | "strict" | undefined;
  /**
   * Origin of the native wallet's postMessage source.
   * When omitted, derived from `document.referrer` (https only) and falls
   * back to `window.location.origin`.
   *
   * SECURITY: In `strict` mode this field is required and must be explicit.
   * In `legacy` mode omission is allowed for backward compatibility, but should
   * be avoided in production.
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
   * When `true` (opt-in), a minimal session snapshot is stored in
   * `sessionStorage` so a full page reload can skip a second native session
   * handshake for the same tab. Keep disabled for stricter XSS threat models.
   */
  readonly persistSession?: boolean | undefined;

  /**
   * Enable SDK telemetry logging to the console.
   *
   * When `true`, the SDK emits lightweight diagnostic events (connect latency,
   * restore decisions, timeouts, and user rejections) via `console.log`.
   *
   * Defaults to `false` / `undefined` (disabled).
   */
  readonly metrics?: boolean | undefined;
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
  readonly requestId: string;
  readonly clientId: string;
}

/**
 * Shape of `signAndSendTransactionResponse` and `signMessageResponse` event detail.
 */
export interface NativeSignatureEvent {
  readonly signature?: string;
  readonly hash?: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly sessionId?: string;
}

/**
 * Shape of `onRejectResponse` event detail.
 * Emitted by the native layer when the user rejects an operation.
 */
interface NativeRejectEvent {
  readonly status?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly code?: string | number;
  readonly requestId: string;
  readonly clientId: string;
  readonly sessionId?: string;
}

/**
 *
 */
export interface NativeEventPayloadMap {
  onWalletSession: NativeSessionEvent;
  signAndSendTransactionResponse: NativeSignatureEvent;
  signMessageResponse: NativeSignatureEvent;
  onRejectResponse: NativeRejectEvent;
}

/**
 *
 */
export interface WaitContext {
  requestId: string;
  clientId: string;
  sessionId?: string;
}

/**
 *
 */
export type NativeEventName =
  | "onWalletSession"
  | "signAndSendTransactionResponse"
  | "signMessageResponse"
  | "onRejectResponse";

/**
 *
 */
export interface PendingSlot<T> {
  key: string;
  eventName: NativeEventName;
  requestId: string;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  listener: EventListener;
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
