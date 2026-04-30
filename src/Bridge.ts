/**
 * @file Bridge.ts
 * Promise-based postMessage bridge for communicating with the Outlaw wallet window.
 *
 * Responsibilities:
 *  - Serialise JSON-RPC requests and post them to the target window
 *  - Correlate responses by request id and resolve/reject in-flight promises
 *  - Auto-detect wallet origin from referrer / query param
 *  - Validate origin and client identity on every inbound message
 *
 * Public API:
 *  - call()    — typed promise-based request/response
 *  - notify()  — fire-and-forget (no response expected)
 *  - send()    — backward-compatible alias for notify() that returns the request id
 *  - ping()    — lightweight health check
 *  - start() / stop() — lifecycle hooks (start() is called automatically)
 */

import type {
  BridgeEnvelope,
  BridgePostContext,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./bridgeTypes.js";
import type { BridgeRpcMap, RpcArgs, RpcResult } from "./bridgeRpc.js";
import { isBridgeResponseEnvelope } from "./rpcGuards.js";
import type { DAppInfo } from "./types.js";
import { SDKError, SDKErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import { randomUUID } from "./crypto.js";

interface WalletNativeBridge {
  postMessage: (message: string) => void;
  onmessage?: WalletNativeMessageHandler | undefined;
  __outlawNativeHandlers?: Set<WalletNativeMessageHandler>;
  __outlawNativeDispatcher?: WalletNativeMessageHandler;
  __outlawNativePreviousOnMessage?: WalletNativeMessageHandler | undefined;
}

type WalletNativeMessageHandler = (event: { data: string }) => void;

declare global {
  interface Window {
    OutlawNative?: WalletNativeBridge;
  }
}

// ─── Origin detection ─────────────────────────────────────────────────────────

const ALLOWED_WALLET_ORIGIN_PROTOCOLS = new Set(["https:"]);

export function detectWalletOrigin(override?: string): string {
  if (override?.trim()) {
    return validateAndNormaliseOrigin(override, "config.walletOrigin");
  }

  if (typeof window === "undefined") {
    return "";
  }

  // Query param origin detection is intentionally forbidden because URL params are attacker-controlled.
  if (document.referrer) {
    try {
      const referrerUrl = new URL(document.referrer);
      if (ALLOWED_WALLET_ORIGIN_PROTOCOLS.has(referrerUrl.protocol)) {
        return referrerUrl.origin;
      }
    } catch {
      // fall through
    }
  }

  return window.location.origin;
}

function validateAndNormaliseOrigin(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SDKError(
      SDKErrorCode.INVALID_CONFIG,
      `${field} is not a valid URL: "${raw}"`,
    );
  }

  if (!ALLOWED_WALLET_ORIGIN_PROTOCOLS.has(url.protocol)) {
    throw new SDKError(
      SDKErrorCode.INVALID_CONFIG,
      `${field} must use https: — got "${url.protocol}"`,
    );
  }
  return url.origin;
}

export interface WalletBridgeOptions {
  walletOrigin: string; /** Origin of the wallet (e.g. "https://wallet.example"). */
  targetWindow?: Window; /** Usually window.parent for iframe, window.opener for popup. */
  clientId?: string; /** Optional, auto-generated if not provided. */
  timeoutMs?: number; /** Request timeout in ms (default: 30 000). */
  /**
   * When set, `dapp` and `requested` are merged into every JSON-RPC `params`.
   * Call-specific params override the same top-level keys.
   */
  bridgeContext?: BridgePostContext;
}

/**
 * Extended config that accepts the legacy `dapp` / `chains` / `logger` fields.
 * Those fields are converted to `bridgeContext` internally.
 */
export interface BridgeConfig extends WalletBridgeOptions {
  dapp?: DAppInfo;
  chains?: readonly string[];
  logger?: Logger;
}

// ─── Internal pending-request slot ────────────────────────────────────────────

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: number;
};

// ─── WalletBridge ─────────────────────────────────────────────────────────────

export class WalletBridge {
  readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly bridgeContext?: BridgePostContext;
  private readonly logger: Logger | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private started = false;
  private readonly nativeOnMessage: WalletNativeMessageHandler = (event) => {
    this.handleNativeMessage(event.data);
  };
  /**
   * When set (after `WalletSDK` connect), every outbound envelope includes this value
   * and inbound `OUTLAW_BRIDGE_RESPONSE` with a `sessionId` field must match.
   */
  private sessionBinding: string | null = null;

  /**
   * Creates a bridge client configured to communicate with a wallet window via
   * `postMessage`, including request correlation and timeout behaviour.
   *
   * Accepts either `WalletBridgeOptions` (new API) or the legacy `BridgeConfig`
   * shape with `dapp`, `chains`, and `logger` fields.
   */
  constructor(options: BridgeConfig) {
    this.clientId = options.clientId ?? randomUUID();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger;

    // Resolve bridgeContext — prefer explicit field, fall back to dapp/chains conversion
    if (options.bridgeContext) {
      this.bridgeContext = options.bridgeContext;
    } else if (options.dapp && options.chains) {
      this.bridgeContext = buildBridgeContext(options.dapp, options.chains);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Registers the message listener used to receive wallet JSON-RPC responses.
   * Safe to call multiple times — only registers once.
   */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.attachNativeListener();
  }

  /**
   * Unregisters the message listener and rejects all in-flight requests to
   * prevent unresolved promises during teardown.
   */
  public stop(): void {
    if (!this.started) return;
    this.started = false;
    const bridge = window.OutlawNative;
    if (bridge) {
      unregisterNativeHandler(bridge, this.nativeOnMessage);
    }

    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge stopped"));
      this.pending.delete(id);
    }
  }

  /**
   * Binds the RSA session key to outbound bridge envelopes and optionally validates
   * inbound `sessionId` on responses (defense in depth; primary trust is
   * `origin` + `source` + `clientId`).
   */
  public setSessionBinding(sessionId: string | null): void {
    this.sessionBinding = sessionId;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Sends a typed JSON-RPC request and returns a promise that resolves with the
   * wallet response or rejects on wallet error or timeout.
   */
  public async call<M extends keyof BridgeRpcMap>(
    method: M,
    ...args: RpcArgs<M>
  ): Promise<RpcResult<M>> {
    this.start();
    const params = args[0];
    const id = this.postRequest(method, params);

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge call timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
    });

    return (await responsePromise) as RpcResult<M>;
  }

  /**
   * Sends a fire-and-forget JSON-RPC notification without waiting for a response.
   * Use for non-critical notifications (e.g. `wallet_disconnect`); security-critical
   * results must be delivered via a correlated `OUTLAW_BRIDGE_RESPONSE` from `call()`.
   */
  public notify<M extends keyof BridgeRpcMap>(
    method: M,
    ...args: RpcArgs<M>
  ): void {
    this.start();
    const params = args[0];
    this.postRequest(method, params);
  }

  /**
   * Backward-compatible variant of `notify()` that accepts untyped params and
   * returns the generated request id (matching the old `Bridge.send()` contract).
   */
  public send(method: string, params?: Record<string, unknown>): string {
    this.start();
    return this.postRequest(method, params) as string;
  }

  /**
   * Performs a lightweight health check to verify that the wallet bridge is
   * reachable and responsive.
   */
  public async ping(): Promise<boolean> {
    try {
      await this.call("wallet_ping");
      return true;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Builds the `{ dapp, requested }` object from `bridgeContext`, defaulting
   * `dapp.url` to `window.location.origin` when the value is blank.
   */
  private resolvedBridgeContextPayload(): BridgePostContext {
    const { dapp, requested } = this.bridgeContext!;

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return {
      dapp: {
        ...dapp,
        url: dapp.url?.trim() ? dapp.url : origin,
      },
      requested: { ...requested },
    };
  }

  /**
   * Merges configured `bridgeContext` into JSON-RPC params. Call-specific params
   * override the same top-level keys. Non-object params are wrapped as
   * `{ _params, dapp, requested }`.
   */
  private applyBridgeContext(params: unknown): unknown {
    if (!this.bridgeContext) return params;
    const base = this.resolvedBridgeContextPayload();
    if (params === undefined || params === null) {
      return base;
    }
    if (typeof params === "object" && !Array.isArray(params)) {
      return { ...base, ...(params as Record<string, unknown>) };
    }
    return { ...base, _params: params };
  }

  /**
   * Creates a typed bridge envelope for a JSON-RPC request, posts it to the
   * configured wallet window, and returns the generated request id.
   */
  private postRequest(method: string, params?: unknown): JsonRpcId {
    const mergedParams = this.applyBridgeContext(params);
    const id = randomUUID();

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: mergedParams,
    };

    const envelope: BridgeEnvelope = {
      type: "OUTLAW_BRIDGE_REQUEST",
      clientId: this.clientId,
      payload: request,
      ...(this.sessionBinding ? { sessionId: this.sessionBinding } : {}),
    };

    const bridge = window.OutlawNative;
    if (!bridge) {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        "window.OutlawNative is not available — cannot send bridge request.",
      );
    }

    bridge.postMessage(JSON.stringify(envelope));
    this.logger?.d(`→ ${method}`, { id, params: mergedParams });

    return id;
  }

  private attachNativeListener(): void {
    const bridge = window.OutlawNative;
    if (!bridge) return;
    registerNativeHandler(bridge, this.nativeOnMessage);
  }

  private handleNativeMessage(raw: string): void {
    let data: unknown = raw;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== "object") return;

    const message = data as Record<string, unknown>;
    if (typeof message["function"] === "string" && "detail" in message) {
      return;
    }
    if (!isBridgeResponseEnvelope(data)) return;
    if (data.clientId !== this.clientId) return;
    if (
      this.sessionBinding &&
      data.sessionId !== undefined &&
      data.sessionId !== this.sessionBinding
    ) {
      this.logger?.w("Ignored bridge response: sessionId mismatch", {
        expected: this.sessionBinding,
        got: data.sessionId,
      });
      return;
    }

    const payload = data.payload as JsonRpcResponse;
    const pending = this.pending.get(payload.id);
    if (!pending) return;

    window.clearTimeout(pending.timeout);
    this.pending.delete(payload.id);

    if ("error" in payload) {
      pending.reject(new BridgeError(payload.error));
    } else {
      pending.resolve(payload.result);
    }
  }
}

// ─── Backward-compatible alias ────────────────────────────────────────────────

/** @deprecated Use `WalletBridge` directly. */
export { WalletBridge as Bridge };

// ─── BridgeError ──────────────────────────────────────────────────────────────

/**
 * Typed error representing a JSON-RPC error returned by the wallet bridge.
 */
export class BridgeError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = "BridgeError";
    this.code = error.code;
    this.data = error.data;
  }

  /** Returns `true` when the error indicates an explicit user rejection. */
  public isUserRejection(): boolean {
    return this.code === -32003;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildBridgeContext(
  dapp: DAppInfo,
  chains: readonly string[],
): BridgePostContext {
  const solanaChain = chains.find((c) => c.startsWith("solana:"));
  const evmChain = chains.find((c) => c.startsWith("eip155:"));
  const requested: { solanaChainId?: string; evmChainId?: string } = {};
  if (solanaChain) requested.solanaChainId = solanaChain;
  if (evmChain) requested.evmChainId = evmChain;
  return {
    dapp: {
      name: dapp.name,
      ...(dapp.description !== undefined && { description: dapp.description }),
      url: dapp.url,
      ...(dapp.icon !== undefined && { icon: dapp.icon }),
    },
    requested,
  };
}

function registerNativeHandler(
  bridge: WalletNativeBridge,
  handler: WalletNativeMessageHandler,
): void {
  if (!bridge.__outlawNativeHandlers) {
    bridge.__outlawNativeHandlers = new Set();
  }
  if (!bridge.__outlawNativeDispatcher) {
    const previous = bridge.onmessage;
    const dispatcher: WalletNativeMessageHandler = (event) => {
      const handlers = bridge.__outlawNativeHandlers;
      if (handlers) {
        for (const h of handlers) h(event);
      }
      if (previous && previous !== dispatcher) previous(event);
    };
    bridge.__outlawNativePreviousOnMessage = previous;
    bridge.__outlawNativeDispatcher = dispatcher;
    bridge.onmessage = dispatcher;
  }
  bridge.__outlawNativeHandlers.add(handler);
}

function unregisterNativeHandler(
  bridge: WalletNativeBridge,
  handler: WalletNativeMessageHandler,
): void {
  const handlers = bridge.__outlawNativeHandlers;
  if (!handlers) return;
  handlers.delete(handler);
  if (handlers.size > 0) return;

  if (
    bridge.__outlawNativeDispatcher &&
    bridge.onmessage === bridge.__outlawNativeDispatcher
  ) {
    bridge.onmessage = bridge.__outlawNativePreviousOnMessage;
  }
  delete bridge.__outlawNativeHandlers;
  delete bridge.__outlawNativeDispatcher;
  delete bridge.__outlawNativePreviousOnMessage;
}
