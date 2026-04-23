/**
 * @file RequestManager.ts
 * The heart of the SDK's promise-based architecture.
 *
 * How it works:
 *  1. A method like `signMessage()` calls `waitForEvent(eventName)`.
 *  2. RequestManager registers a one-shot listener for that native event.
 *  3. When the native app fires the event, the listener resolves the Promise.
 *  4. A timeout guard rejects the Promise if the native side is silent.
 *  5. Everything is cleaned up — no memory leaks, no dangling listeners.
 *
 * This is the ONLY place in the SDK that touches `window.addEventListener`.
 * No React, no UI state, no business logic lives here.
 *
 * ─── Supported native events ────────────────────────────────────────────────
 *  • onWalletSession              → { id, sessionId, chainId, accountId }
 *  • signAndSendTransactionResponse → { signature } | { hash }
 *  • signMessageResponse          → { signature }
 */

import type {
  NativeRejectEvent,
  NativeSessionEvent,
  NativeSignatureEvent,
} from "./types.js";
import { SDKError, SDKErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";

// ─── Supported native event names ────────────────────────────────────────────

export type NativeEventName =
  | "onWalletSession"
  | "signAndSendTransactionResponse"
  | "signMessageResponse"
  | "onRejectResponse";

// Map each event name to its typed payload
export interface NativeEventPayloadMap {
  onWalletSession: NativeSessionEvent;
  signAndSendTransactionResponse: NativeSignatureEvent;
  signMessageResponse: NativeSignatureEvent;
  onRejectResponse: NativeRejectEvent;
}

// ─── Pending slot ─────────────────────────────────────────────────────────────

interface PendingSlot<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  listener: EventListener;
}

// ─── RequestManager ───────────────────────────────────────────────────────────

export class RequestManager {
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  /**
   * One active pending slot per native event type.
   * Because each SDK method maps to exactly one event type, concurrent calls
   * to the same method queue up by replacing the slot — but in practice the
   * SDK serialises calls naturally via async/await at the dApp level.
   * For true concurrency support across different events this is still safe
   * because each event name has its own slot.
   */
  private readonly pending = new Map<NativeEventName, PendingSlot<unknown>>();

  constructor(timeoutMs: number, logger: Logger) {
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  /**
   * Returns a Promise that resolves when the specified native DOM event fires.
   *
   * Registers a one-shot `window` event listener. When the event fires:
   *  - Validates the event detail shape
   *  - Resolves the Promise with the typed payload
   *  - Cleans up the listener and the timeout
   *
   * If no event arrives within `timeoutMs`, the Promise rejects with SDKError.
   */
  public waitForEvent<K extends NativeEventName>(
    eventName: K,
  ): Promise<NativeEventPayloadMap[K]> {
    return new Promise<NativeEventPayloadMap[K]>((resolve, reject) => {
      // Cancel any previously pending slot for the same event
      this.cancel(eventName);

      const listener: EventListener = (ev: Event) => {
        const detail = (ev as CustomEvent<unknown>).detail;
        this.logger.d(`← native event: ${eventName}`, detail);

        if (!this.validateEventDetail(eventName, detail)) {
          this.logger.w(`Malformed native event: ${eventName}`, detail);
          // Don't reject — malformed events from unknown sources should be ignored
          return;
        }

        this.cleanup(eventName);
        resolve(detail as NativeEventPayloadMap[K]);
      };

      const timeoutId = setTimeout(() => {
        this.cleanup(eventName);
        this.logger.w(`Timeout waiting for native event: ${eventName}`);
        reject(
          new SDKError(
            SDKErrorCode.TIMEOUT,
            `No response from native wallet within ${this.timeoutMs}ms (event: ${eventName})`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(eventName, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutId,
        listener,
      });

      window.addEventListener(eventName, listener);
      this.logger.d(`Listening for native event: ${eventName}`);
    });
  }

  /**
   * Cancels any pending wait for the given event name.
   * Called internally before registering a new listener for the same event,
   * and externally during SDK teardown.
   */
  public cancel(eventName: NativeEventName): void {
    const slot = this.pending.get(eventName);
    if (!slot) return;
    this.cleanup(eventName);
    slot.reject(
      new SDKError(
        SDKErrorCode.TIMEOUT,
        `Request cancelled (event: ${eventName})`,
      ),
    );
  }

  /**
   * Cancels all pending event waits. Call on SDK destroy/disconnect.
   */
  public cancelAll(): void {
    for (const eventName of this.pending.keys()) {
      this.cancel(eventName as NativeEventName);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private cleanup(eventName: NativeEventName): void {
    const slot = this.pending.get(eventName);
    if (!slot) return;
    clearTimeout(slot.timeoutId);
    window.removeEventListener(eventName, slot.listener);
    this.pending.delete(eventName);
  }

  /**
   * Runtime validation of native event payloads.
   * Rejects events that don't match the expected shape — protects against
   * malformed or spoofed events from untrusted sources.
   */
  private validateEventDetail(
    eventName: NativeEventName,
    detail: unknown,
  ): boolean {
    if (!detail || typeof detail !== "object") return false;

    const d = detail as Record<string, unknown>;

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

  public get pendingCount(): number {
    return this.pending.size;
  }
}
