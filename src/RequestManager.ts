import { SDKError, SDKErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import type {
  NativeEventName,
  NativeEventPayloadMap,
  WaitContext,
  PendingSlot,
} from "./types.js";

interface WalletNativeBridge {
  postMessage: (message: string) => void;
  onmessage?: WalletNativeMessageHandler | undefined;
  __outlawNativeHandlers?: Set<WalletNativeMessageHandler>;
  __outlawNativeDispatcher?: WalletNativeMessageHandler;
  __outlawNativePreviousOnMessage?: WalletNativeMessageHandler | undefined;
}

type WalletNativeMessageHandler = (event: { data: string }) => void;

interface NativeBridgeMessage {
  function: NativeEventName;
  detail: unknown;
}

declare global {
  interface Window {
    OutlawNative?: WalletNativeBridge;
  }
}

export class RequestManager {
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingSlot<unknown>>();
  private readonly waitContexts = new Map<string, WaitContext>();
  private readonly nativeOnMessage: WalletNativeMessageHandler = (event) => {
    this.handleNativeMessage(event.data);
  };

  constructor(timeoutMs: number, logger: Logger) {
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.logger.i("RequestManager constructor", { timeoutMs });
    this.attachNativeListener();
  }

  public waitForEvent<K extends NativeEventName>(
    eventName: K,
    ctx: WaitContext,
  ): Promise<NativeEventPayloadMap[K]> {
    return new Promise<NativeEventPayloadMap[K]>((resolve, reject) => {
      const key = this.makeKey(eventName, ctx.requestId);
      this.logger.d(
        "waitForEvent() — event requested",
        JSON.stringify({ eventName, ctx, key }),
      );
      this.cancel(key);
      this.attachNativeListener();
      this.waitContexts.set(key, ctx);

      const listener: EventListener = () => undefined;

      const timeoutId = setTimeout(() => {
        this.cleanup(key);
        reject(
          new SDKError(
            SDKErrorCode.TIMEOUT,
            `No response from native wallet within ${this.timeoutMs}ms (event: ${eventName})`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(key, {
        key,
        eventName,
        requestId: ctx.requestId,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutId,
        listener,
      });
    });
  }

  public cancel(key: string): void {
    const slot = this.pending.get(key);
    if (!slot) return;
    this.cleanup(key);
    slot.reject(
      new SDKError(
        SDKErrorCode.TIMEOUT,
        `Request cancelled (${slot.requestId})`,
      ),
    );
  }

  public cancelByRequestId(requestId: string): void {
    const keys: string[] = [];
    for (const [key, slot] of this.pending) {
      if (slot.requestId === requestId) keys.push(key);
    }
    for (const key of keys) this.cancel(key);
  }

  public cancelAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.cancel(key);
    }
  }

  private cleanup(key: string): void {
    const slot = this.pending.get(key);
    if (!slot) return;
    clearTimeout(slot.timeoutId);
    this.pending.delete(key);
    this.waitContexts.delete(key);
  }

  private makeKey(eventName: NativeEventName, requestId: string): string {
    return `${requestId}:${eventName}`;
  }

  private attachNativeListener(): void {
    const bridge = window.OutlawNative;
    if (!bridge) return;
    registerNativeHandler(bridge, this.nativeOnMessage);
  }

  private handleNativeMessage(raw: string): void {
    let parsed: unknown = raw;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return;
      }
    }
    if (!parsed || typeof parsed !== "object") return;

    const message = parsed as Partial<NativeBridgeMessage>;
    if (typeof message.function !== "string") return;
    const eventName = message.function as NativeEventName;
    const detail = message.detail;
    if (!detail || typeof detail !== "object") return;

    const requestId = (detail as Record<string, unknown>)["requestId"];
    if (typeof requestId !== "string" || !requestId) return;

    const key = this.makeKey(eventName, requestId);
    const slot = this.pending.get(key);
    if (!slot) return;
    const ctx = this.waitContexts.get(key);
    if (!ctx) return;

    // ── Validate the event detail against our pending context ────────────────
    // `validateEventDetail` returns null on success, or a diagnostic reason
    // string on failure. A non-null reason means the native layer sent a
    // response for *our* request but it failed validation — we reject the slot
    // immediately with a generic INVALID_EVENT error so the caller gets a clear,
    // actionable signal instead of waiting for a 30-second timeout.
    const rejectionReason = this.validateEventDetail(eventName, detail, ctx);
    if (rejectionReason !== null) {
      // Full diagnostic detail is logged internally (visible via debug: true).
      // The public-facing error is intentionally generic to avoid leaking
      // validation internals to callers.
      this.logger.w(`handleNativeMessage() — rejected ${eventName} event`, {
        reason: rejectionReason,
        requestId,
      });
      this.cleanup(key);
      slot.reject(
        new SDKError(
          SDKErrorCode.INVALID_EVENT,
          "Wallet response is missing or contains invalid required parameters.",
        ),
      );
      return;
    }

    this.cleanup(key);
    slot.resolve(detail);
  }

  /**
   * Validates the correlation fields and payload shape of a received native
   * event against the pending request context.
   *
   * Returns `null` when the event is valid and should be resolved.
   * Returns a non-empty diagnostic reason string when the event should be
   * rejected — `handleNativeMessage` logs it internally and immediately rejects
   * the pending slot with a generic `INVALID_EVENT` error.
   *
   * ### Session-id policy
   * `sessionId` is **always required** on sign events (`signMessageResponse`,
   * `signAndSendTransactionResponse`) and must match the bound session.
   * The native layer must include `sessionId` in every sign response.
   */
  private validateEventDetail(
    eventName: NativeEventName,
    detail: unknown,
    ctx: WaitContext,
  ): string | null {
    if (!detail || typeof detail !== "object") {
      return "event detail is missing or not an object";
    }
    const d = detail as Record<string, unknown>;

    if (d["requestId"] !== ctx.requestId) {
      return `requestId mismatch: expected "${ctx.requestId}", got "${d["requestId"]}"`;
    }
    if (d["clientId"] !== ctx.clientId) {
      return `clientId mismatch: expected "${ctx.clientId}", got "${d["clientId"]}"`;
    }

    // ── Session-id correlation ───────────────────────────────────────────────
    // sessionId is REQUIRED on all sign events and must exactly match the
    // bound session. The native layer must always include it in sign responses.
    if (ctx.sessionId) {
      const isSignEvent =
        eventName === "signMessageResponse" ||
        eventName === "signAndSendTransactionResponse";

      if (isSignEvent) {
        if (typeof d["sessionId"] !== "string" || !d["sessionId"]) {
          return (
            `sessionId is required on "${eventName}" but was absent. ` +
            `The native layer must include sessionId in every sign response.`
          );
        }
        if (d["sessionId"] !== ctx.sessionId) {
          return (
            `sessionId mismatch on "${eventName}": ` +
            `expected "${ctx.sessionId}", got "${d["sessionId"]}". ` +
            `Possible session-fixation or replay attempt.`
          );
        }
      } else if (
        d["sessionId"] !== undefined &&
        d["sessionId"] !== ctx.sessionId
      ) {
        // Non-sign events: reject when sessionId is present but wrong.
        return (
          `sessionId mismatch: expected "${ctx.sessionId}", ` +
          `got "${d["sessionId"]}". Possible replay or routing error.`
        );
      }
    }

    // ── Payload shape checks ─────────────────────────────────────────────────
    switch (eventName) {
      case "onWalletSession": {
        if (typeof d["sessionId"] !== "string" || d["sessionId"].length === 0) {
          return "onWalletSession: sessionId field is missing or empty";
        }
        if (typeof d["chainId"] !== "string") {
          return "onWalletSession: chainId field is missing or not a string";
        }
        if (typeof d["accountId"] !== "string") {
          return "onWalletSession: accountId field is missing or not a string";
        }
        return null;
      }

      case "signAndSendTransactionResponse": {
        const hasSignature =
          typeof d["signature"] === "string" && d["signature"].length > 0;
        const hasHash = typeof d["hash"] === "string" && d["hash"].length > 0;
        if (!hasSignature && !hasHash) {
          return (
            "signAndSendTransactionResponse: response must contain a non-empty " +
            '"signature" (Solana) or "hash" (EVM) field'
          );
        }
        return null;
      }

      case "signMessageResponse": {
        if (typeof d["signature"] !== "string" || d["signature"].length === 0) {
          return 'signMessageResponse: "signature" field is missing or empty';
        }
        return null;
      }

      case "onRejectResponse": {
        const hasReason =
          typeof d["status"] === "string" ||
          typeof d["message"] === "string" ||
          typeof d["reason"] === "string" ||
          typeof d["code"] === "string" ||
          typeof d["code"] === "number";
        if (!hasReason) {
          return (
            "onRejectResponse: at least one of status/message/reason/code " +
            "must be present"
          );
        }
        return null;
      }

      default:
        return `unknown event name: "${eventName}"`;
    }
  }
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
