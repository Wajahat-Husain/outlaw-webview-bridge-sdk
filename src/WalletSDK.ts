/**
 * @file WalletSDK.ts
 * The single public entry point for the Outlaw WebView Wallet SDK.
 *
 *   const sdk = new WalletSDK({ dapp: { name: "My dApp", url: "..." }, chains: ["solana:devnet"] })
 *   const { address, chainId, connected, expiresAt } = await sdk.connect("solana:devnet")
 *   const { signature } = await sdk.signMessage({ message: "Hello, Outlaw!" })
 *   const { signature } = await sdk.signAndSendTransaction({ transaction: tx })
 */

import type {
  AccountInfo,
  Eip712TypedDataV4,
  Session,
  WalletResponse,
  WalletSDKTelemetryEvent,
  SolanaSignMessagePayload,
  SolanaTransactionPayload,
  WalletSDKConfig,
  EVMSignMessagePayload,
  EVMTransactionPayload,
  NativeEventName,
  NativeEventPayloadMap,
} from "./types.js";
import { SDKError, SDKErrorCode } from "./errors.js";
import { Bridge, detectWalletOrigin } from "./Bridge.js";
import { encryptHybridJson, randomUUID } from "./crypto.js";
import { RequestManager } from "./RequestManager.js";
import { Logger } from "./logger.js";
import bs58 from "bs58";
import { toSolanaSignTransactionPayload } from "./solanaHelpers.js";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { addressFromAccountId, sameChainId, assertAccountChainMatch } from "./accountId.js";
import {
  buildWalletCreateSessionRequested,
  resolveChain,
} from "./chainRegistry.js";
import {
  validateResolvedChainRpc,
  type RpcValidationMode,
} from "./chainConnection.js";
import {
  clearPersistedSession,
  loadPersistedSession,
  makeSdkFingerprint,
  savePersistedSession,
  type PersistedSessionPayload,
} from "./sessionPersistence.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type InternalSession = {
  sessionId: string;
  chainId: string;
  accountId: string;
  address: string;
  expiresAt: number;
  rpcUrl: string;
  family: "solana" | "evm";
};

/** Safe for `debug` logs only — omits encryption key material and full RPC URL. */
function internalSessionForDebugLog(
  s: InternalSession,
): Record<string, unknown> {
  let rpcHost = "[invalid-url]";
  try {
    rpcHost = new URL(s.rpcUrl).host;
  } catch {
    /* ignore */
  }
  return {
    chainId: s.chainId,
    family: s.family,
    address: s.address,
    accountId: s.accountId,
    expiresAt: s.expiresAt,
    sessionId: "[redacted]",
    rpcHost,
  };
}

// ─── WalletSDK ────────────────────────────────────────────────────────────────

/**
 * The WalletSDK class is the main entry point for the Outlaw WebView Wallet SDK.
 * It provides a simple API for connecting to the native wallet, signing messages,
 * and sending transactions.
 * @param config - The configuration for the WalletSDK. This includes the dApp information,
 * the chains to connect to, the wallet origin, the timeout, the session TTL, the persist session,
 * and the chain RPC overrides.
 */
export class WalletSDK {
  private readonly bridge: Bridge;
  private readonly requests: RequestManager;
  private readonly logger: Logger;
  private readonly securityMode: "legacy" | "strict";
  private readonly metricsEnabled: boolean;
  private readonly configuredChains: readonly string[];
  private readonly allowedChains: ReadonlySet<string>;
  private readonly sessionTtlMs: number;
  private readonly persistSession: boolean;
  private readonly rpcValidation: RpcValidationMode;
  private readonly chainRpcOverrides:
    | Readonly<Record<string, string>>
    | undefined;
  private readonly storageFingerprint: string;
  private readonly initialSnapshot: PersistedSessionPayload | null;
  private internal: InternalSession | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  // Prevent parallel `connect()` calls in the same SDK instance from racing
  // and overwriting each other's internal session state.
  private connectInFlight: Promise<Session> | null = null;
  private connectInFlightChainId: string | null = null;

  /**
   * Constructs a new WalletSDK instance.
   * @param config - The configuration for the WalletSDK.
   */
  constructor(config: WalletSDKConfig) {
    const securityMode = config.securityMode ?? "legacy";
    this.validateConfig(config, securityMode);
    this.securityMode = securityMode;
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

    // Session persistence is opt-in only. Persisted snapshots in sessionStorage
    // are readable/tamperable by same-origin scripts (including XSS).
    this.persistSession = config.persistSession === true;

    this.rpcValidation = config.rpcValidation ?? "chainIdOnly";
    this.chainRpcOverrides = config.chainRpcOverrides;
    this.configuredChains = Object.freeze(
      config.chains.map((c) => c.trim()).filter(Boolean),
    );
    this.allowedChains = new Set(this.configuredChains);

    this.logger = new Logger(config.debug ?? false);
    this.metricsEnabled = config.metrics ?? false;
    this.storageFingerprint = makeSdkFingerprint(
      config.dapp.url,
      config.chains,
    );

    this.initialSnapshot = this.persistSession
      ? loadPersistedSession(this.storageFingerprint)
      : null;
    const persistedClientId = this.resolvePersistedClientId(
      this.initialSnapshot,
    );

    const walletOrigin = detectWalletOrigin(config.walletOrigin);
    const targetWindow = config.targetWindow ?? window.parent;
    const timeoutMs = config.timeoutMs ?? 30_000;

    this.bridge = new Bridge({
      walletOrigin,
      targetWindow,
      dapp: config.dapp,
      chains: config.chains,
      ...(persistedClientId ? { clientId: persistedClientId } : {}),
      logger: this.logger,
      timeoutMs,
    });
    this.requests = new RequestManager(timeoutMs, this.logger);

    this.logger.i("WalletSDK initialised", {
      dapp: config.dapp.name,
      chains: [...this.allowedChains],
      walletOrigin,
      timeoutMs,
      sessionTtlMs: this.sessionTtlMs,
      persistSession: this.persistSession,
      rpcValidation: this.rpcValidation,
      securityMode: this.securityMode,
    });

    this.hydrateFromStorage(this.initialSnapshot);
  }

  private emitTelemetry(event: WalletSDKTelemetryEvent): void {
    if (!this.metricsEnabled) return;
    // Keep telemetry minimal; do not log sensitive material.
    console.log("[sdk-metric]", event);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Connects to the native wallet for a specific CAIP-2 `chainId` (must be one of
   * the `chains` passed to the constructor), verifies the default/custom RPC, and
   * returns a dApp-safe snapshot (address + expiry) — the encryption key stays internal.
   * @param chainId - The chain ID to connect to.
   * @returns The session.
   */
  public async connect(chainId: string): Promise<Session> {
    this.assertCriticalResponseTransport("connect");
    const id = this.normaliseChainId(chainId);
    this.assertChainAllowed(id);
    const callStartedAtMs = Date.now();

    while (true) {
      const inflight = this.connectInFlight;
      if (inflight) {
        // De-dupe: if the same chain connect is already in progress,
        // return the exact same in-flight Promise.
        if (this.connectInFlightChainId === id) {
          // Important: we must return the *same* Promise reference so
          // parallel connect() calls can be deduped deterministically.
          inflight
            .then(() => {
              this.emitTelemetry({
                type: "connect_latency",
                chainId: id,
                latencyMs: Date.now() - callStartedAtMs,
                success: true,
              });
            })
            .catch((e) => {
              if (e instanceof SDKError) {
                if (e.code === SDKErrorCode.TIMEOUT) {
                  this.emitTelemetry({
                    type: "timeout",
                    operation: "connect",
                    chainId: id,
                    latencyMs: Date.now() - callStartedAtMs,
                  });
                } else if (e.code === SDKErrorCode.USER_REJECTED) {
                  this.emitTelemetry({
                    type: "rejection",
                    operation: "connect",
                    chainId: id,
                    latencyMs: Date.now() - callStartedAtMs,
                    code: e.code,
                    message: e.message,
                  });
                }
              }
              this.emitTelemetry({
                type: "connect_latency",
                chainId: id,
                latencyMs: Date.now() - callStartedAtMs,
                success: false,
              });
            });
          return inflight;
        }

        // Another chain connect is in progress; wait and retry.
        try {
          await inflight;
        } catch {
          // ignore; we will attempt connect again for `id`
        }
        continue;
      }

      // Become the leader for connect operations.
      const op = this.connectUnlocked(id);
      this.connectInFlight = op;
      this.connectInFlightChainId = id;

      try {
        const session = await op;
        this.emitTelemetry({
          type: "connect_latency",
          chainId: id,
          latencyMs: Date.now() - callStartedAtMs,
          success: true,
        });
        return session;
      } catch (e) {
        if (e instanceof SDKError) {
          if (e.code === SDKErrorCode.TIMEOUT) {
            this.emitTelemetry({
              type: "timeout",
              operation: "connect",
              chainId: id,
              latencyMs: Date.now() - callStartedAtMs,
            });
          } else if (e.code === SDKErrorCode.USER_REJECTED) {
            this.emitTelemetry({
              type: "rejection",
              operation: "connect",
              chainId: id,
              latencyMs: Date.now() - callStartedAtMs,
              code: e.code,
              message: e.message,
            });
          }
        }
        this.emitTelemetry({
          type: "connect_latency",
          chainId: id,
          latencyMs: Date.now() - callStartedAtMs,
          success: false,
        });
        throw e;
      } finally {
        if (this.connectInFlight === op) {
          this.connectInFlight = null;
          this.connectInFlightChainId = null;
        }
      }
    }
  }

  private async connectUnlocked(chainId: string): Promise<Session> {
    this.clearIfExpired();

    if (
      this.internal &&
      !this.isExpired() &&
      sameChainId(this.internal.chainId, chainId)
    ) {
      return this.toPublic();
    }

    if (this.persistSession) {
      const snap = loadPersistedSession(this.storageFingerprint);
      const restored =
        !!snap &&
        sameChainId(snap.chainId, chainId) &&
        Date.now() < snap.expiresAt;

      this.emitTelemetry({
        type: "session_restore",
        chainId,
        hit: restored,
      });

      if (restored) {
        this.assertChainAllowed(snap.chainId);
        const restoreable = this.validateAndNormaliseSnapshot(snap);
        if (!restoreable) {
          clearPersistedSession(this.storageFingerprint);
        } else {
          this.applySnapshot(restoreable);
          this.scheduleExpiry();
          this.logger.i("connect() — restored session from sessionStorage", {
            chainId,
          });
          return this.toPublic();
        }
      }
    }

    this.logger.i("connect() — requesting native session", { chainId });

    const requestId = randomUUID();
    const requested = buildWalletCreateSessionRequested(chainId);

    const sessionPromise = this.waitForEventOrReject(
      "onWalletSession",
      requestId,
    );

    this.bridge.send("wallet_createSession", {
      requested,
      requestId,
      clientId: this.bridge.clientId,
    });

    const event = await sessionPromise;

    const reportedChainId = this.resolveSessionChainId(event);
    if (!sameChainId(reportedChainId, chainId)) {
      throw new SDKError(
        SDKErrorCode.INVALID_EVENT,
        `Network mismatch: requested ${chainId}, native reported ${reportedChainId || "(empty)"}`,
      );
    }

    // ── CAIP-10 binding check ────────────────────────────────────────────────
    // Require that the namespace:reference embedded in accountId exactly equals
    // the negotiated chainId. This closes the exploit where a compromised native
    // layer returns a valid chainId for one network but an accountId that encodes
    // a different network, causing the dApp to act on a mixed identity.
    assertAccountChainMatch(event.accountId, reportedChainId);

    const resolved = resolveChain(chainId, this.chainRpcOverrides);
    try {
      await validateResolvedChainRpc(
        resolved,
        this.rpcValidation,
        (msg, data) => this.logger.d(msg, data),
      );
    } catch (e) {
      this.tryNotifyNativeDisconnect(event.sessionId);
      throw e;
    }
    const address = addressFromAccountId(event.accountId);
    const expiresAt = Date.now() + this.sessionTtlMs;

    this.internal = {
      sessionId: event.sessionId,
      chainId: reportedChainId,
      accountId: event.accountId,
      address,
      expiresAt,
      rpcUrl: resolved.rpcUrl,
      family: resolved.family,
    };
    this.bridge.setSessionBinding(event.sessionId);
    this.logger.i(
      "internal session set",
      internalSessionForDebugLog(this.internal),
    );

    this.persistCurrentSession();
    this.scheduleExpiry();
    this.logger.i("Session established", { chainId, address });
    return this.toPublic();
  }

  /**
   * Signs a message using the Solana protocol.
   * @param payload - The message to sign.
   * @returns The signature.
   */
  public async signMessage(
    payload: SolanaSignMessagePayload | EVMSignMessagePayload,
  ): Promise<WalletResponse> {
    this.assertCriticalResponseTransport("signMessage");
    const s = this.requireUsableSession();
    this.logger.i(`signMessage() for ${s.family}`);
    const startedAtMs = Date.now();
    try {
      if (s.family === "evm") {
        return this.signMessageEVM(payload as EVMSignMessagePayload, s);
      }

      return this.signMessageSolana(payload as SolanaSignMessagePayload, s);
    } catch (e) {
      if (e instanceof SDKError) {
        if (e.code === SDKErrorCode.TIMEOUT) {
          this.emitTelemetry({
            type: "timeout",
            operation: "signMessage",
            chainId: s.chainId,
            latencyMs: Date.now() - startedAtMs,
          });
        } else if (e.code === SDKErrorCode.USER_REJECTED) {
          this.emitTelemetry({
            type: "rejection",
            operation: "signMessage",
            chainId: s.chainId,
            latencyMs: Date.now() - startedAtMs,
            code: e.code,
            message: e.message,
          });
        }
      }
      throw e;
    }
  }

  /**
   * Signs and sends a transaction using the Solana protocol.
   * @param payload - The transaction to sign and send.
   * @returns The transaction hash.
   */
  public async signAndSendTransaction(
    payload: SolanaTransactionPayload | EVMTransactionPayload,
  ): Promise<WalletResponse> {
    this.assertCriticalResponseTransport("signAndSendTransaction");
    const s = this.requireUsableSession();
    const startedAtMs = Date.now();
    try {
      if (s.family === "evm") {
        return this.signAndSendTransactionEVM(
          payload as EVMTransactionPayload,
          s,
        );
      }

      return this.signAndSendTransactionSolana(
        payload as SolanaTransactionPayload,
        s,
      );
    } catch (e) {
      if (e instanceof SDKError) {
        if (e.code === SDKErrorCode.TIMEOUT) {
          this.emitTelemetry({
            type: "timeout",
            operation: "signAndSendTransaction",
            chainId: s.chainId,
            latencyMs: Date.now() - startedAtMs,
          });
        } else if (e.code === SDKErrorCode.USER_REJECTED) {
          this.emitTelemetry({
            type: "rejection",
            operation: "signAndSendTransaction",
            chainId: s.chainId,
            latencyMs: Date.now() - startedAtMs,
            code: e.code,
            message: e.message,
          });
        }
      }
      throw e;
    }
  }

  /**
   * Single account summary for dApp UI logic.
   */
  public useAccount(): AccountInfo {
    this.clearIfExpired();
    const s = this.internal;
    if (!s || this.isExpired()) {
      return {
        address: null,
        isConnected: false,
        caipAddress: null,
        status: "disconnected",
      };
    }

    return {
      address: s.address,
      isConnected: true,
      caipAddress: `${s.chainId}:${s.address}`,
      status: "connected",
    };
  }

  /**
   * Checks if the session is connected.
   * @returns True if the session is connected, false otherwise.
   */
  public isConnected(): boolean {
    this.clearIfExpired();
    const s = this.internal;
    if (!s || this.isExpired()) {
      return false;
    }
    return true;
  }

  /**
   * Clears local session state, cancels in-flight event waits, optionally notifies
   * the native wallet via `wallet_disconnect`, and removes any persisted tab snapshot.
   */
  public disconnect(): void {
    this.teardownSession({ notifyNative: true, reason: "disconnect" });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Signs a message using the Solana protocol.
   * @param payload - The message to sign.
   * @param s - The internal session.
   * @returns The signature.
   */
  private async signMessageSolana(
    payload: SolanaSignMessagePayload,
    s: InternalSession,
  ): Promise<WalletResponse> {
    const requestId = randomUUID();
    const message = payload.message;
    if (message === undefined) {
      this.cancelPendingRequest(requestId);
      throw new SDKError(SDKErrorCode.INVALID_PAYLOAD, "message is required");
    }

    try {
      const bytes =
        typeof message === "string"
          ? new TextEncoder().encode(message)
          : message;
      const b58 = bs58.encode(bytes);
      const encryptedPayload = await this.encrypt(
        { publicKey: s.address, message: b58 },
        s.sessionId,
      );

      const responsePromise = this.waitForEventOrReject(
        "signMessageResponse",
        requestId,
        s.sessionId,
      );

      this.bridge.notify("solana_signMessage", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
        requestId,
        clientId: this.bridge.clientId,
        sessionId: s.sessionId,
      });

      const event = await responsePromise;
      if (!event.signature) {
        throw new SDKError(
          SDKErrorCode.INVALID_EVENT,
          "Missing signature in signMessageResponse",
        );
      }

      return { signature: event.signature };
    } catch (e) {
      this.cancelPendingRequest(requestId);
      throw e;
    }
  }

  /**
   * Signs and sends a transaction using the Solana protocol.
   * @param payload - The transaction to sign and send.
   * @param s - The internal session.
   * @returns The transaction hash.
   */
  private async signAndSendTransactionSolana(
    payload: SolanaTransactionPayload,
    s: InternalSession,
  ): Promise<WalletResponse> {
    const requestId = randomUUID();
    try {
      // coerce the transaction to the expected format
      const tx = this.coerceTransaction(payload.transaction);
      if (!tx) {
        this.cancelPendingRequest(requestId);
        throw new SDKError(
          SDKErrorCode.INVALID_PAYLOAD,
          "Invalid Solana transaction — pass a @solana/web3.js Transaction or a serialisable plain object",
        );
      }

      // convert to the payload expected by the native wallet
      const transactionPayload = toSolanaSignTransactionPayload(tx);
      const encryptedPayload = await this.encrypt(
        transactionPayload,
        s.sessionId,
      );

      // wait for the response from the native wallet
      const responsePromise = this.waitForEventOrReject(
        "signAndSendTransactionResponse",
        requestId,
        s.sessionId,
      );

      // notify the native wallet
      this.bridge.notify("solana_signTransaction", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
        requestId,
        clientId: this.bridge.clientId,
        sessionId: s.sessionId,
      });

      // wait for the response from the native wallet
      const event = await responsePromise;
      if (!event.signature) {
        throw new SDKError(
          SDKErrorCode.INVALID_EVENT,
          "Missing signature in signAndSendTransactionResponse",
        );
      }

      // return the signature
      return { signature: event.signature };
    } catch (e) {
      this.cancelPendingRequest(requestId);
      throw e;
    }
  }

  /**
   * Signs a message using the EVM protocol.
   * @param payload - The message to sign.
   * @param s - The internal session.
   * @returns The signature.
   */
  private async signMessageEVM(
    payload: EVMSignMessagePayload,
    s: InternalSession,
  ): Promise<WalletResponse> {
    const requestId = randomUUID();
    const responsePromise = this.waitForEventOrReject(
      "signMessageResponse",
      requestId,
      s.sessionId,
    );

    if ("typedData" in payload) {
      this.assertEip712TypedDataV4(payload.typedData);

      try {
        const encryptedPayload = await this.encrypt(
          [s.address, payload.typedData],
          s.sessionId,
        );

        this.bridge.notify("eth_signTypedData_v4", {
          encryptedPayload,
          requested: buildWalletCreateSessionRequested(s.chainId),
          requestId,
          clientId: this.bridge.clientId,
          sessionId: s.sessionId,
        });

        const event = await responsePromise;
        if (!event.signature) {
          throw new SDKError(
            SDKErrorCode.INVALID_EVENT,
            "Missing signature in signMessageResponse",
          );
        }
        return { signature: event.signature };
      } catch (e) {
        this.cancelPendingRequest(requestId);
        throw e;
      }
    }

    const message = payload.message;
    if (!message) {
      this.cancelPendingRequest(requestId);
      throw new SDKError(SDKErrorCode.INVALID_PAYLOAD, "message is required");
    }

    const hex =
      typeof message === "string"
        ? "0x" + Buffer.from(message, "utf8").toString("hex")
        : "0x" + Buffer.from(message).toString("hex");

    try {
      const encryptedPayload = await this.encrypt(
        [hex, s.address],
        s.sessionId,
      );

      this.bridge.notify("personal_sign", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
        requestId,
        clientId: this.bridge.clientId,
        sessionId: s.sessionId,
      });

      const event = await responsePromise;
      if (!event.signature) {
        throw new SDKError(
          SDKErrorCode.INVALID_EVENT,
          "Missing signature in signMessageResponse",
        );
      }

      return { signature: event.signature };
    } catch (e) {
      this.cancelPendingRequest(requestId);
      throw e;
    }
  }

  private assertEip712TypedDataV4(data: Eip712TypedDataV4): void {
    if (!data || typeof data !== "object") {
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "typedData must be an object",
      );
    }
    if (
      !data.types ||
      typeof data.types !== "object" ||
      Array.isArray(data.types)
    ) {
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "typedData.types is required and must be a record of type definitions",
      );
    }
    if (typeof data.primaryType !== "string" || !data.primaryType) {
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "typedData.primaryType is required",
      );
    }
    if (!data.domain || typeof data.domain !== "object") {
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "typedData.domain is required",
      );
    }
    if (data.message == null || typeof data.message !== "object") {
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "typedData.message is required",
      );
    }
  }

  /**
   * Signs and sends a transaction using the EVM protocol.
   * @param payload - The transaction to sign and send.
   * @param s - The internal session.
   * @returns The transaction hash.
   */
  private async signAndSendTransactionEVM(
    payload: EVMTransactionPayload,
    s: InternalSession,
  ): Promise<WalletResponse> {
    const requestId = randomUUID();
    try {
      const encryptedPayload = await this.encrypt([payload], s.sessionId);

      const responsePromise = this.waitForEventOrReject(
        "signAndSendTransactionResponse",
        requestId,
        s.sessionId,
      );

      this.bridge.notify("eth_sendTransaction", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
        requestId,
        clientId: this.bridge.clientId,
        sessionId: s.sessionId,
      });

      const event = await responsePromise;
      if (!event.hash) {
        throw new SDKError(
          SDKErrorCode.INVALID_EVENT,
          "Missing hash in signAndSendTransactionResponse",
        );
      }

      return { hash: event.hash } as WalletResponse;
    } catch (e) {
      this.cancelPendingRequest(requestId);
      throw e;
    }
  }

  /**
   * Normalises a chain ID by trimming whitespace.
   * @param c - The chain ID to normalise.
   * @returns The normalised chain ID.
   */
  private normaliseChainId(c: string): string {
    return c.trim();
  }

  private waitForEventOrReject<K extends NativeEventName>(
    eventName: K,
    requestId: string,
    sessionId?: string,
  ): Promise<NativeEventPayloadMap[K]> {
    const ctx = {
      requestId,
      clientId: this.bridge.clientId,
      ...(sessionId ? { sessionId } : {}),
    };
    this.logger.d(
      "waitForEventOrReject() — event requested",
      JSON.stringify({ eventName, ctx }),
    );
    const successPromise = this.requests.waitForEvent(eventName, ctx);
    const rejectPromise = this.requests.waitForEvent("onRejectResponse", ctx);
    this.logger.d(
      "waitForEventOrReject() — event requested",
      JSON.stringify({ eventName, ctx }),
    );
    return Promise.race([
      successPromise,
      rejectPromise.then((event) => {
        throw this.toRejectError(event);
      }),
    ]).finally(() => {
      this.cancelPendingRequest(requestId);
    }) as Promise<NativeEventPayloadMap[K]>;
  }

  private cancelPendingRequest(requestId: string): void {
    this.requests.cancelByRequestId(requestId);
  }

  private toRejectError(event: {
    status?: string;
    message?: string;
    reason?: string;
    code?: string | number;
  }): SDKError {
    const message =
      event.message ||
      event.reason ||
      event.status ||
      "Request rejected by user";
    const err = new SDKError(SDKErrorCode.USER_REJECTED, message);
    err.stack = "";
    return err;
  }

  /**
   * Resolves the chain ID from the session event.
   * @param event - The session event.
   * @returns The resolved chain ID.
   */
  private resolveSessionChainId(event: {
    chainId: string;
    accountId: string;
  }): string {
    const chainId = event.chainId.trim();
    if (chainId) return chainId;

    const parts = event.accountId.split(":");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}:${parts[1]}`;
    }

    return chainId;
  }

  /**
   * Asserts that the chain ID is allowed.
   * @param chainId - The chain ID to assert.
   */
  private assertChainAllowed(chainId: string): void {
    if (!this.allowedChains.has(chainId)) {
      throw new SDKError(
        SDKErrorCode.CHAIN_NOT_ALLOWED,
        `Chain "${chainId}" is not in the SDK allow-list. Constructor chains: ${[...this.allowedChains].join(", ")}`,
      );
    }
  }

  /**
   * Validates the configuration.
   * @param config - The configuration to validate.
   */
  private validateConfig(
    config: WalletSDKConfig,
    securityMode: "legacy" | "strict",
  ): void {
    if (!config.walletOrigin?.trim() && securityMode === "strict") {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        "walletOrigin is required in securityMode='strict'. Set config.walletOrigin explicitly.",
      );
    }
    if (!config.walletOrigin?.trim() && securityMode === "legacy") {
      console.warn(
        "[OutlawSDK] walletOrigin not provided — auto-detection can be unsafe in production embeds. Set config.walletOrigin explicitly.",
      );
    }
    if (!config.dapp.name?.trim()) {
      throw new SDKError(SDKErrorCode.INVALID_CONFIG, "dapp.name is required");
    }
    if (!config.dapp.url?.trim()) {
      throw new SDKError(SDKErrorCode.INVALID_CONFIG, "dapp.url is required");
    }
    if (!config.chains || config.chains.length === 0) {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        "At least one chain is required (e.g. 'solana:devnet')",
      );
    }
    const invalid = config.chains.filter(
      (c) => !c.startsWith("solana:") && !c.startsWith("eip155:"),
    );
    if (invalid.length > 0) {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        `Unknown chain format: ${invalid.join(", ")} — use CAIP-2 (e.g. "solana:devnet")`,
      );
    }
    for (const c of config.chains) {
      const id = c.trim();
      try {
        resolveChain(id, config.chainRpcOverrides);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new SDKError(
          SDKErrorCode.INVALID_CONFIG,
          `Chain "${id}" is not in the built-in registry and has no chainRpcOverrides entry: ${msg}`,
        );
      }
    }
  }

  private assertCriticalResponseTransport(
    operation: "connect" | "signMessage" | "signAndSendTransaction",
  ): void {
    const native =
      typeof window !== "undefined" ? (window as any).OutlawNative : null;
    if (!native || typeof native.postMessage !== "function") {
      throw new SDKError(
        SDKErrorCode.INVALID_CONFIG,
        `window.OutlawNative must exist before calling ${operation}().`,
      );
    }
  }

  /**
   * Hydrates the session from storage.
   */
  private hydrateFromStorage(snapshot?: PersistedSessionPayload | null): void {
    if (!this.persistSession) return;
    const snap = snapshot ?? loadPersistedSession(this.storageFingerprint);
    if (!snap) return;
    try {
      this.assertChainAllowed(snap.chainId);
    } catch {
      clearPersistedSession(this.storageFingerprint);
      return;
    }
    if (Date.now() >= snap.expiresAt) {
      clearPersistedSession(this.storageFingerprint);
      return;
    }
    const restoreable = this.validateAndNormaliseSnapshot(snap);
    if (!restoreable) {
      clearPersistedSession(this.storageFingerprint);
      return;
    }
    this.applySnapshot(restoreable);
    this.scheduleExpiry();
    this.logger.i("Re-hydrated session from sessionStorage", {
      chainId: snap.chainId,
    });
  }

  /**
   * Applies a snapshot of the session to the internal state.
   * @param snap - The snapshot to apply.
   */
  private applySnapshot(snap: PersistedSessionPayload): void {
    const resolved = resolveChain(snap.chainId, this.chainRpcOverrides);
    const rpcUrl = snap.rpcUrl || resolved.rpcUrl;
    this.internal = {
      sessionId: snap.sessionId,
      chainId: snap.chainId,
      accountId: snap.accountId,
      address: snap.address,
      expiresAt: snap.expiresAt,
      rpcUrl,
      // Never trust persisted family from storage; derive from chainId.
      family: resolved.family,
    };
    this.bridge.setSessionBinding(snap.sessionId);
  }

  private validateAndNormaliseSnapshot(
    snap: PersistedSessionPayload,
  ): PersistedSessionPayload | null {
    try {
      const resolved = resolveChain(snap.chainId, this.chainRpcOverrides);
      const derivedAddress = addressFromAccountId(snap.accountId);
      if (!derivedAddress || !snap.address) return null;
      if (derivedAddress !== snap.address) return null;
      if (resolved.family !== snap.family) return null;
      return {
        ...snap,
        // Always trust chain/account derivation over persisted family.
        family: resolved.family,
      };
    } catch {
      return null;
    }
  }

  private resolvePersistedClientId(
    snapshot: PersistedSessionPayload | null,
  ): string | null {
    if (!snapshot?.clientId) return null;
    try {
      this.assertChainAllowed(snapshot.chainId);
    } catch {
      return null;
    }
    return snapshot.clientId;
  }

  /**
   * Persists the current session to storage.
   */
  private persistCurrentSession(): void {
    if (!this.persistSession || !this.internal) return;
    const payload: PersistedSessionPayload = {
      v: 1,
      clientId: this.bridge.clientId,
      sessionId: this.internal.sessionId,
      chainId: this.internal.chainId,
      accountId: this.internal.accountId,
      address: this.internal.address,
      expiresAt: this.internal.expiresAt,
      rpcUrl: this.internal.rpcUrl,
      family: this.internal.family,
      checksum: "pending",
    };
    try {
      savePersistedSession(this.storageFingerprint, payload);
    } catch (e) {
      this.logger.w("Could not persist session to sessionStorage", e);
    }
  }

  /**
   * Checks if the session is expired.
   * @returns True if the session is expired, false otherwise.
   */
  private isExpired(): boolean {
    if (!this.internal) return true;
    return Date.now() >= this.internal.expiresAt;
  }

  /**
   * Clears the session if it is expired.
   */
  private clearIfExpired(): void {
    if (this.internal && this.isExpired()) {
      this.teardownSession({ notifyNative: true, reason: "expired" });
    }
  }

  /**
   * Schedules the expiry of the session.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (!this.internal) return;
    const ms = this.internal.expiresAt - Date.now();
    if (ms <= 0) {
      this.clearIfExpired();
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.logger.i("Session TTL reached");
      this.teardownSession({ notifyNative: true, reason: "expired" });
    }, ms);
  }

  /**
   * Tears down the session.
   * @param options - The options for tearing down the session.
   */
  private teardownSession(options: {
    notifyNative: boolean;
    reason: "disconnect" | "expired";
  }): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    const sid = this.internal?.sessionId;
    this.internal = null;
    if (this.persistSession) {
      clearPersistedSession(this.storageFingerprint);
    }
    this.requests.cancelAll();
    this.bridge.setSessionBinding(null);
    if (options.notifyNative && sid) {
      try {
        this.bridge.notify("wallet_disconnect", { sessionId: sid });
      } catch {
        // ignore
      }
    }
    this.bridge.stop();
    this.logger.i("Session torn down", { reason: options.reason });
  }

  private tryNotifyNativeDisconnect(sessionId?: string): void {
    if (!sessionId) return;
    try {
      this.bridge.notify("wallet_disconnect", { sessionId });
    } catch {
      // ignore cleanup errors for best-effort teardown
    }
  }

  /**
   * Converts the internal session to a public session.
   * @returns The public session.
   */
  private toPublic(): Session {
    if (!this.internal) {
      throw new SDKError(
        SDKErrorCode.NOT_CONNECTED,
        "No active session — call sdk.connect() first",
      );
    }
    return {
      address: this.internal.address,
      chainId: this.internal.chainId,
      connected: true,
      expiresAt: this.internal.expiresAt,
    };
  }

  /**
   * Requires a usable session.
   * @returns The usable session.
   */
  private requireUsableSession(): InternalSession {
    if (!this.internal) {
      throw new SDKError(
        SDKErrorCode.NOT_CONNECTED,
        "No active session — call sdk.connect() first",
      );
    }
    if (this.isExpired()) {
      this.teardownSession({ notifyNative: true, reason: "expired" });
      throw new SDKError(
        SDKErrorCode.SESSION_EXPIRED,
        "Session expired — call sdk.connect() again",
      );
    }
    return this.internal;
  }

  /**
   * Encrypts a payload using the hybrid encryption algorithm.
   * @param payload - The payload to encrypt.
   * @param sessionId - The session ID.
   * @returns The encrypted payload.
   */
  private async encrypt(
    payload: unknown,
    sessionId: string,
  ): ReturnType<typeof encryptHybridJson> {
    try {
      return await encryptHybridJson(payload, sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SDKError(SDKErrorCode.ENCRYPTION_FAILED, msg);
    }
  }

  /**
   * Coerces an input to a Transaction.
   * @param input - The input to coerce.
   * @returns The coerced Transaction.
   */
  private coerceTransaction(input: unknown): Transaction | null {
    if (input instanceof Transaction) return input;
    if (!input || typeof input !== "object") return null;

    const candidate = input as {
      feePayer?: string;
      recentBlockhash?: string;
      instructions?: Array<{
        programId: string;
        keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
        data: number[] | Uint8Array;
      }>;
    };

    if (
      !candidate.feePayer ||
      !candidate.recentBlockhash ||
      !Array.isArray(candidate.instructions)
    ) {
      return null;
    }

    try {
      const tx = new Transaction({
        feePayer: new PublicKey(candidate.feePayer),
        recentBlockhash: candidate.recentBlockhash,
      });

      for (const ix of candidate.instructions) {
        const keys = ix.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: Boolean(k.isSigner),
          isWritable: Boolean(k.isWritable),
        }));
        const rawData =
          ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data);
        const data = Buffer.from(rawData);

        tx.add(
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys,
            data,
          }),
        );
      }

      return tx;
    } catch {
      return null;
    }
  }
}
