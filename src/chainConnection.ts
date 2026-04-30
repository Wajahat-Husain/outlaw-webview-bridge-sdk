/**
 * @file chainConnection.ts
 * Runtime RPC validation helpers for `connect()`.
 *
 * Do not use `console.*` here: validation runs on the connect path and would
 * leak RPC endpoints. Optional `debugLog` is invoked only when the SDK enables
 * debug and should redact at the call site.
 */

import { Connection } from "@solana/web3.js";
import type { ResolvedChain } from "./chainRegistry.js";
import { eip155Caip2ToHexChainId } from "./chainRegistry.js";

export type RpcValidationMode = "off" | "chainIdOnly" | "full";

const DEFAULT_VALIDATION_TIMEOUT_MS = 8_000;

function rpcHostOnly(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * Validates a resolved chain RPC according to `mode`.
 * - `off`: skip probes.
 * - `chainIdOnly`: verify EVM chain id only.
 * - `full`: verify EVM chain id and Solana reachability.
 */
export async function validateResolvedChainRpc(
  resolved: ResolvedChain,
  mode: RpcValidationMode,
  debugLog?: (msg: string, data?: unknown) => void,
): Promise<void> {
  if (mode === "off") return;

  debugLog?.("validateResolvedChainRpc", {
    caip2: resolved.caip2,
    family: resolved.family,
    mode,
    rpcHost: rpcHostOnly(resolved.rpcUrl),
  });

  if (resolved.family === "solana") {
    if (mode === "full") {
      await verifySolanaReachability(resolved.rpcUrl);
    }
    return;
  }

  await verifyEvmChainId(resolved.rpcUrl, resolved.caip2);
}

async function verifyEvmChainId(
  rpcUrl: string,
  eip155Caip2: string,
): Promise<void> {
  const expected = eip155Caip2ToHexChainId(eip155Caip2);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("RPC validation timed out"),
    DEFAULT_VALIDATION_TIMEOUT_MS,
  );
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!res.ok) {
    throw new Error(`EVM RPC error: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { result?: string };
  const got = body.result;
  if (!got) {
    throw new Error("eth_chainId: empty result");
  }
  const gotN = normaliseChainIdToBigInt(got);
  const expN = normaliseChainIdToBigInt(expected);
  if (gotN !== expN) {
    throw new Error(
      `eth_chainId mismatch: expected ${expected} (${expN.toString()}), got ${got} — check RPC for ${eip155Caip2}`,
    );
  }
}

function normaliseChainIdToBigInt(hex: string): bigint {
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex : `0x${hex}`;
  return BigInt(s);
}

async function verifySolanaReachability(rpcUrl: string): Promise<void> {
  const conn = new Connection(rpcUrl, "confirmed");
  await promiseWithTimeout(conn.getVersion(), DEFAULT_VALIDATION_TIMEOUT_MS);
}

async function promiseWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("RPC validation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
