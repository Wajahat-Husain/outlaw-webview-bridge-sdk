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
  private previousNativeOnMessage: WalletNativeMessageHandler | undefined;
  private readonly nativeOnMessage: WalletNativeMessageHandler = (event) => {
    this.handleNativeMessage(event.data);
    this.previousNativeOnMessage?.(event);
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
    if (bridge.onmessage === this.nativeOnMessage) return;
    this.previousNativeOnMessage = bridge.onmessage;
    bridge.onmessage = this.nativeOnMessage;
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
    if (!this.validateEventDetail(eventName, detail, ctx)) return;

    this.cleanup(key);
    slot.resolve(detail);
  }

  private validateEventDetail(
    eventName: NativeEventName,
    detail: unknown,
    ctx: WaitContext,
  ): boolean {
    if (!detail || typeof detail !== "object") return false;
    const d = detail as Record<string, unknown>;
    if (d["requestId"] !== ctx.requestId) return false;
    if (d["clientId"] !== ctx.clientId) return false;
    if (
      ctx.sessionId &&
      d["sessionId"] !== undefined &&
      d["sessionId"] !== ctx.sessionId
    ) {
      return false;
    }

    switch (eventName) {
      case "onWalletSession":
        return (
          typeof d["sessionId"] === "string" &&
          d["sessionId"].length > 0 &&
          typeof d["chainId"] === "string" &&
          typeof d["accountId"] === "string"
        );
      case "signAndSendTransactionResponse":
        return (
          (typeof d["signature"] === "string" && d["signature"].length > 0) ||
          (typeof d["hash"] === "string" && d["hash"].length > 0)
        );
      case "signMessageResponse":
        return typeof d["signature"] === "string" && d["signature"].length > 0;
      case "onRejectResponse":
        return (
          typeof d["status"] === "string" ||
          typeof d["message"] === "string" ||
          typeof d["reason"] === "string" ||
          typeof d["code"] === "string" ||
          typeof d["code"] === "number"
        );
      default:
        return false;
    }
  }
}
