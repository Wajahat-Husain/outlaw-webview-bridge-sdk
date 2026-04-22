/**
 * @file logger.ts
 * Minimal structured logger — all output gated on `debug` flag.
 */

const TAG = "[OutlawSDK]";

export class Logger {
  constructor(private readonly enabled: boolean) {}

  public d(msg: string, data?: unknown): void {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.debug(`${TAG} ${msg}`, data ?? "");
  }

  public i(msg: string, data?: unknown): void {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.info(`${TAG} ${msg}`, data ?? "");
  }

  public w(msg: string, data?: unknown): void {
    // Warnings always print regardless of debug flag
    // eslint-disable-next-line no-console
    console.warn(`${TAG} ${msg}`, data ?? "");
  }

  public e(msg: string, data?: unknown): void {
    // Errors always print regardless of debug flag
    // eslint-disable-next-line no-console
    console.error(`${TAG} ${msg}`, data ?? "");
  }
}
