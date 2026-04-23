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
import type { Logger } from "./logger.js";
import { randomUUID } from "./crypto.js";

// ─── Origin detection ─────────────────────────────────────────────────────────

export function detectWalletOrigin(override?: string): string {
  if (override) return override;

  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get(
      "walletOrigin",
    );
    if (fromQuery) return fromQuery;

    if (document.referrer) {
      try {
        return new URL(document.referrer).origin;
      } catch {
        // fall through
      }
    }

    return window.location.origin;
  }

  return "";
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
  private readonly walletOrigin: string;
  private readonly targetWindow: Window;
  private readonly timeoutMs: number;
  private readonly bridgeContext?: BridgePostContext;
  private readonly logger: Logger | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private started = false;

  /**
   * Creates a bridge client configured to communicate with a wallet window via
   * `postMessage`, including request correlation and timeout behaviour.
   *
   * Accepts either `WalletBridgeOptions` (new API) or the legacy `BridgeConfig`
   * shape with `dapp`, `chains`, and `logger` fields.
   */
  constructor(options: BridgeConfig) {
    this.clientId = options.clientId ?? randomUUID();
    this.walletOrigin = options.walletOrigin;
    this.targetWindow = options.targetWindow ?? window.parent;
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
    window.addEventListener("message", this.handleMessageEvent);
  }

  /**
   * Unregisters the message listener and rejects all in-flight requests to
   * prevent unresolved promises during teardown.
   */
  public stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener("message", this.handleMessageEvent);

    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge stopped"));
      this.pending.delete(id);
    }
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
   *
   * Use this when confirmation is delivered through an alternate channel
   * (for example, injected DOM events) rather than a `postMessage` reply.
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
    };

    this.targetWindow.postMessage(envelope, this.walletOrigin);
    this.logger?.d(`→ ${method}`, { id, params: mergedParams });

    return id;
  }

  /**
   * Processes inbound `postMessage` events from the wallet by validating origin,
   * source, and client identity, then resolving or rejecting the matching pending
   * JSON-RPC request.
   */
  private handleMessageEvent = (ev: MessageEvent): void => {
    if (ev.origin !== this.walletOrigin) return;
    if (ev.source !== this.targetWindow) return;

    const data = ev.data;
    if (!isBridgeResponseEnvelope(data)) return;
    if (data.clientId !== this.clientId) return;

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
  };
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
