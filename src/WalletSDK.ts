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
  SignatureResult,
  SolanaPayload,
  WalletSDKConfig,
} from "./types.js";
import { SDKError, SDKErrorCode } from "./errors.js";
import { Bridge, detectWalletOrigin } from "./Bridge.js";
import { RequestManager } from "./RequestManager.js";
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
    const sessionPromise = this.requests.waitForEvent("onWalletSession");
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
    this.logger.i("Internal session established", {
      chainId: reportedChainId,
      accountId: event.accountId,
      address,
      expiresAt,
      family: resolved.family,
      rpcUrl: resolved.rpcUrl,
    });

    this.persistCurrentSession();
    this.scheduleExpiry();
    this.logger.i("Session established", { chainId: id, address });
    return this.toPublic();
  }

  public async signMessage(payload: SolanaPayload): Promise<SignatureResult> {
    this.logger.i("signMessage()");
    const responsePromise = this.requests.waitForEvent("signMessageResponse");
    const s = this.requireUsableSession();
    this.logger.i("Sign message using session", {
      chainId: s.chainId,
      accountId: s.accountId,
      address: s.address,
      expiresAt: s.expiresAt,
      family: s.family,
      rpcUrl: s.rpcUrl,
    });

    const message = payload.message;
    if (message === undefined) {
      this.requests.cancel("signMessageResponse");
      throw new SDKError(
        SDKErrorCode.INVALID_PAYLOAD,
        "message is required in SolanaPayload",
      );
    }
    const bytes =
      typeof message === "string" ? new TextEncoder().encode(message) : message;
    const b58 = bs58.encode(bytes);
    try {
      const encryptedPayload = await this.encrypt(
        { messageBase58: b58 },
        s.sessionId,
      );
      this.bridge.notify("solana_signMessage", { encryptedPayload });
    } catch (e) {
      this.requests.cancel("signMessageResponse");
      throw e;
    }
    const event = await responsePromise;
    return { signature: event.signature };
  }

  public async signAndSendTransaction(
    payload: SolanaPayload,
  ): Promise<SignatureResult> {
    this.logger.i("signAndSendTransaction()");
    const s = this.requireUsableSession();
    const responsePromise = this.requests.waitForEvent(
      "signAndSendTransactionResponse",
    );
    try {
      const tx = this.coerceTransaction(payload.transaction);
      if (!tx) {
        this.requests.cancel("signAndSendTransactionResponse");
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
      this.bridge.notify("solana_signTransaction", { encryptedPayload });
    } catch (e) {
      this.requests.cancel("signAndSendTransactionResponse");
      throw e;
    }
    const event = await responsePromise;
    return { signature: event.signature };
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

  private normaliseChainId(c: string): string {
    return c.trim();
  }

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

  private assertChainAllowed(chainId: string): void {
    if (!this.allowedChains.has(chainId)) {
      throw new SDKError(
        SDKErrorCode.CHAIN_NOT_ALLOWED,
        `Chain "${chainId}" is not in the SDK allow-list. Constructor chains: ${[...this.allowedChains].join(", ")}`,
      );
    }
  }

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

  private isExpired(): boolean {
    if (!this.internal) return true;
    return Date.now() >= this.internal.expiresAt;
  }

  private clearIfExpired(): void {
    if (this.internal && this.isExpired()) {
      this.teardownSession({ notifyNative: true, reason: "expired" });
    }
  }

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
