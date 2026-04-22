/**
 * @file chainConnection.ts
 * Light RPC handshakes to bind a session to a concrete network before returning from `connect()`.
 */

import { Connection } from "@solana/web3.js";
import type { ChainFamily, ResolvedChain } from "./chainRegistry.js";
import { eip155Caip2ToHexChainId } from "./chainRegistry.js";

/**
 * For Solana, creates a `Connection` and issues a low-cost `getVersion()` call.
 * For EVM, verifies `eth_chainId` from the public RPC.
 */
export async function establishConnection(resolved: ResolvedChain): Promise<{
  family: ChainFamily;
  solana?: Connection;
  evm?: { rpcUrl: string };
}> {
  if (resolved.family === "solana") {
    const conn = new Connection(resolved.rpcUrl, "confirmed");
    await conn.getVersion();
    return { family: "solana", solana: conn };
  }

  await verifyEvmChainId(resolved.rpcUrl, resolved.caip2);
  return { family: "evm", evm: { rpcUrl: resolved.rpcUrl } };
}

async function verifyEvmChainId(
  rpcUrl: string,
  eip155Caip2: string,
): Promise<void> {
  const expected = eip155Caip2ToHexChainId(eip155Caip2);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
  });
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
