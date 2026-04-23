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
  Session,
  WalletResponse,
  SolanaSignMessagePayload,
  SolanaTransactionPayload,
  WalletSDKConfig,
  EVMSignMessagePayload,
  EVMTransactionPayload,
} from "./types.js";
import { SDKError, SDKErrorCode } from "./errors.js";
import { Bridge, detectWalletOrigin } from "./Bridge.js";
import {
  RequestManager,
  type NativeEventName,
  type NativeEventPayloadMap,
} from "./RequestManager.js";
import { encryptHybridJson } from "./crypto.js";
import { Logger } from "./logger.js";
import bs58 from "bs58";
import { toSolanaSignTransactionPayload } from "./solanaHelpers.js";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { addressFromAccountId, sameChainId } from "./accountId.js";
import {
  buildWalletCreateSessionRequested,
  resolveChain,
} from "./chainRegistry.js";
import { establishConnection } from "./chainConnection.js";
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
  private readonly configuredChains: readonly string[];
  private readonly allowedChains: ReadonlySet<string>;
  private readonly sessionTtlMs: number;
  private readonly persistSession: boolean;
  private readonly chainRpcOverrides:
    | Readonly<Record<string, string>>
    | undefined;
  private readonly storageFingerprint: string;
  private internal: InternalSession | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Constructs a new WalletSDK instance.
   * @param config - The configuration for the WalletSDK.
   */
  constructor(config: WalletSDKConfig) {
    this.validateConfig(config);
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.persistSession = config.persistSession !== false;
    this.chainRpcOverrides = config.chainRpcOverrides;
    this.configuredChains = Object.freeze(
      config.chains.map((c) => c.trim()).filter(Boolean),
    );
    this.allowedChains = new Set(this.configuredChains);

    this.logger = new Logger(config.debug ?? false);
    this.storageFingerprint = makeSdkFingerprint(
      config.dapp.url,
      config.chains,
    );

    const walletOrigin = detectWalletOrigin(config.walletOrigin);
    const targetWindow = config.targetWindow ?? window.parent;
    const timeoutMs = config.timeoutMs ?? 30_000;

    this.bridge = new Bridge({
      walletOrigin,
      targetWindow,
      dapp: config.dapp,
      chains: config.chains,
      logger: this.logger,
    });

    this.requests = new RequestManager(timeoutMs, this.logger);

    this.logger.i("WalletSDK initialised", {
      dapp: config.dapp.name,
      chains: [...this.allowedChains],
      walletOrigin,
      timeoutMs,
      sessionTtlMs: this.sessionTtlMs,
      persistSession: this.persistSession,
    });

    this.hydrateFromStorage();
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
    const id = this.normaliseChainId(chainId);
    this.assertChainAllowed(id);
    this.clearIfExpired();

    if (
      this.internal &&
      !this.isExpired() &&
      sameChainId(this.internal.chainId, id)
    ) {
      return this.toPublic();
    }

    if (this.persistSession) {
      const snap = loadPersistedSession(this.storageFingerprint);
      if (
        snap &&
        sameChainId(snap.chainId, id) &&
        Date.now() < snap.expiresAt
      ) {
        this.assertChainAllowed(snap.chainId);
        this.applySnapshot(snap);
        this.scheduleExpiry();
        this.logger.i("connect() — restored session from sessionStorage", {
          chainId: id,
        });
        return this.toPublic();
      }
    }

    this.logger.i("connect() — requesting native session", { chainId: id });

    const sessionPromise = this.waitForEventOrReject("onWalletSession");
    const requested = buildWalletCreateSessionRequested(id);
    this.bridge.send("wallet_createSession", { requested });
    const event = await sessionPromise;

    const reportedChainId = this.resolveSessionChainId(event);
    if (!sameChainId(reportedChainId, id)) {
      throw new SDKError(
        SDKErrorCode.INVALID_EVENT,
        `Network mismatch: requested ${id}, native reported ${reportedChainId || "(empty)"}`,
      );
    }

    const resolved = resolveChain(id, this.chainRpcOverrides);
    await establishConnection(resolved);
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
    this.logger.i(`internal session set: ${JSON.stringify(this.internal)}`);

    this.persistCurrentSession();
    this.scheduleExpiry();
    this.logger.i("Session established", { chainId: id, address });
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
    const s = this.requireUsableSession();
    this.logger.i(`signMessage() for ${s.family}`);

    if (s.family === "evm") {
      return this.signMessageEVM(payload as EVMSignMessagePayload, s);
    }

    return this.signMessageSolana(payload as SolanaSignMessagePayload, s);
  }

  /**
   * Signs and sends a transaction using the Solana protocol.
   * @param payload - The transaction to sign and send.
   * @returns The transaction hash.
   */
  public async signAndSendTransaction(
    payload: SolanaTransactionPayload | EVMTransactionPayload,
  ): Promise<WalletResponse> {
    const s = this.requireUsableSession();

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
    const responsePromise = this.waitForEventOrReject("signMessageResponse");
    const message = payload.message;
    if (message === undefined) {
      this.cancelPendingRequest("signMessageResponse");
      throw new SDKError(SDKErrorCode.INVALID_PAYLOAD, "message is required");
    }

    try {
      const bytes =
        typeof message === "string"
          ? new TextEncoder().encode(message)
          : message;
      const b58 = bs58.encode(bytes);
      const encryptedPayload = await this.encrypt(
        { messageBase58: b58 },
        s.sessionId,
      );
      this.bridge.notify("solana_signMessage", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
      });
    } catch (e) {
      this.cancelPendingRequest("signMessageResponse");
      throw e;
    }

    const event = await responsePromise;
    return { signature: (event as { signature: string }).signature };
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
    const responsePromise = this.waitForEventOrReject(
      "signAndSendTransactionResponse",
    );

    try {
      const tx = this.coerceTransaction(payload.transaction);
      if (!tx) {
        this.cancelPendingRequest("signAndSendTransactionResponse");
        throw new SDKError(
          SDKErrorCode.INVALID_PAYLOAD,
          "Invalid Solana transaction — pass a @solana/web3.js Transaction or a serialisable plain object",
        );
      }
      const transactionPayload = toSolanaSignTransactionPayload(tx);
      const encryptedPayload = await this.encrypt(
        transactionPayload,
        s.sessionId,
      );
      this.bridge.notify("solana_signTransaction", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
      });
    } catch (e) {
      this.cancelPendingRequest("signAndSendTransactionResponse");
      throw e;
    }
    const event = await responsePromise;
    return { signature: (event as { signature: string }).signature };
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
    const responsePromise = this.waitForEventOrReject("signMessageResponse");
    const message = payload.message;
    if (!message) {
      this.cancelPendingRequest("signMessageResponse");
      throw new SDKError(SDKErrorCode.INVALID_PAYLOAD, "message is required");
    }

    // Ensure hex encoding for EVM
    const hex =
      typeof message === "string"
        ? "0x" + Buffer.from(message, "utf8").toString("hex")
        : "0x" + Buffer.from(message).toString("hex");
    try {
      const encryptedPayload = await this.encrypt(
        [hex, s.address],
        s.sessionId,
      );
      this.bridge.notify("eth_sign", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
      });
    } catch (e) {
      this.cancelPendingRequest("signMessageResponse");
      throw e;
    }
    const event = await responsePromise;
    return { signature: (event as { signature: string }).signature };
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
    const responsePromise = this.waitForEventOrReject(
      "signAndSendTransactionResponse",
    );

    try {
      const encryptedPayload = await this.encrypt([payload], s.sessionId);
      this.bridge.notify("eth_sendTransaction", {
        encryptedPayload,
        requested: buildWalletCreateSessionRequested(s.chainId),
      });
    } catch (e) {
      this.cancelPendingRequest("signAndSendTransactionResponse");
      throw e;
    }

    const event = await responsePromise;
    return {
      hash: (event as { hash: string }).hash,
      signature: (event as { signature: string }).signature,
    };
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
  ): Promise<NativeEventPayloadMap[K]> {
    const successPromise = this.requests.waitForEvent(eventName);
    const rejectPromise = this.requests.waitForEvent("onRejectResponse");

    return Promise.race([
      successPromise,
      rejectPromise.then((event) => {
        throw this.toRejectError(event);
      }),
    ]).finally(() => {
      this.cancelPendingRequest(eventName);
    }) as Promise<NativeEventPayloadMap[K]>;
  }

  private cancelPendingRequest(eventName: NativeEventName): void {
    this.requests.cancel(eventName);
    this.requests.cancel("onRejectResponse");
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
    // Do not leak SDK internals (paths/line numbers) to dApps on user rejection.
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
  private validateConfig(config: WalletSDKConfig): void {
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

  /**
   * Hydrates the session from storage.
   */
  private hydrateFromStorage(): void {
    if (!this.persistSession) return;
    const snap = loadPersistedSession(this.storageFingerprint);
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
    this.applySnapshot(snap);
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
      family: snap.family,
    };
  }

  /**
   * Persists the current session to storage.
   */
  private persistCurrentSession(): void {
    if (!this.persistSession || !this.internal) return;
    const payload: PersistedSessionPayload = {
      v: 1,
      sessionId: this.internal.sessionId,
      chainId: this.internal.chainId,
      accountId: this.internal.accountId,
      address: this.internal.address,
      expiresAt: this.internal.expiresAt,
      rpcUrl: this.internal.rpcUrl,
      family: this.internal.family,
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
    if (options.notifyNative && sid) {
      try {
        this.bridge.notify("wallet_disconnect", { sessionId: sid });
      } catch {
        // ignore
      }
    }
    this.logger.i("Session torn down", { reason: options.reason });
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
