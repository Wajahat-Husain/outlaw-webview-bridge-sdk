/**
 * @file chainRegistry.ts
 * Whitelisted CAIP-2 chains and default public RPC endpoints.
 *
 * dApps can override per-chain RPC via `WalletSDKConfig.chainRpcOverrides`.
 * All RPCs are untrusted: the SDK only uses them to verify reachability and
 * (for EVM) that `eth_chainId` matches the expected network.
 */

export type ChainFamily = "solana" | "evm";

export interface ResolvedChain {
  readonly caip2: string;
  readonly family: ChainFamily;
  /** Default or overridden JSON-RPC / Solana HTTP endpoint. */
  readonly rpcUrl: string;
}

/**
 * Default RPC URLs (public, rate-limited). Replace in production with your own
 * infrastructure where reliability and privacy matter.
 */
const DEFAULT_CHAINS: Record<string, { family: ChainFamily; rpcUrl: string }> =
  {
    "solana:mainnet-beta": {
      family: "solana",
      rpcUrl: "https://api.mainnet-beta.solana.com",
    },
    "solana:devnet": {
      family: "solana",
      rpcUrl: "https://api.devnet.solana.com",
    },
    "solana:testnet": {
      family: "solana",
      rpcUrl: "https://api.testnet.solana.com",
    },
    "eip155:1": { family: "evm", rpcUrl: "https://ethereum.publicnode.com" },
    "eip155:5": { family: "evm", rpcUrl: "https://rpc.ankr.com/eth_goerli" },
    "eip155:56": { family: "evm", rpcUrl: "https://bsc.publicnode.com" },
    "eip155:97": {
      family: "evm",
      rpcUrl: "https://bsctestapi.terminet.io/bscTestnet",
    },
    "eip155:137": {
      family: "evm",
      rpcUrl: "https://polygon-bor.publicnode.com",
    },
    "eip155:80001": {
      family: "evm",
      rpcUrl: "https://rpc.ankr.com/polygon_mumbai",
    },
    "eip155:42161": {
      family: "evm",
      rpcUrl: "https://arbitrum-one.publicnode.com",
    },
    "eip155:10": { family: "evm", rpcUrl: "https://mainnet.optimism.io" },
    "eip155:8453": { family: "evm", rpcUrl: "https://base-rpc.publicnode.com" },
  };

/**
 * Exposed for allow-list checks and custom deployments that extend the map at runtime.
 */
export function isKnownDefaultChain(caip2: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CHAINS, caip2);
}

/**
 * Resolves `caip2` to family + rpcUrl using defaults and optional overrides.
 */
export function resolveChain(
  caip2: string,
  overrides?: Readonly<Record<string, string>>,
): ResolvedChain {
  const override = overrides?.[caip2]?.trim();
  const entry = DEFAULT_CHAINS[caip2];
  if (!entry) {
    if (override) {
      return {
        caip2,
        family: inferFamily(caip2),
        rpcUrl: override,
      };
    }
    throw new Error(
      `Unknown chain "${caip2}" — add it to the SDK registry or pass chainRpcOverrides["${caip2}"]`,
    );
  }
  return {
    caip2,
    family: entry.family,
    rpcUrl: override ?? entry.rpcUrl,
  };
}

function inferFamily(caip2: string): ChainFamily {
  if (caip2.startsWith("solana:")) return "solana";
  if (caip2.startsWith("eip155:")) return "evm";
  return "evm";
}

const SUPPORTED_NAMESPACES = new Set(["solana", "eip155"]);

function extractNamespace(caip2: string): string {
  const [namespace] = caip2.split(":");
  if (!namespace) {
    throw new Error(`Invalid CAIP-2 format: ${caip2}`);
  }
  return namespace;
}

/** Maps CAIP-2 to the `requested` field for `wallet_createSession` params. */
export function buildWalletCreateSessionRequested(caip2: string): {
  chainId?: string;
} {
  const namespace = extractNamespace(caip2);

  if (!SUPPORTED_NAMESPACES.has(namespace)) {
    throw new Error(`Unsupported chain namespace: ${namespace}`);
  }

  return { chainId: caip2 };
}

/** Converts `eip155:1` to `0x1` for `eth_chainId` comparison. */
export function eip155Caip2ToHexChainId(caip2: string): `0x${string}` {
  const m = /^eip155:([0-9]+)$/.exec(caip2);
  if (!m?.[1]) {
    throw new Error(`Not a valid eip155 CAIP-2 id: ${caip2}`);
  }
  const n = BigInt(m[1]);
  const hex = n.toString(16);
  return `0x${hex}`;
}
