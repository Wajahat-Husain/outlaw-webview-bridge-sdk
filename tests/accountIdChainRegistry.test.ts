import { addressFromAccountId, sameChainId } from "../src/accountId";
import {
  buildWalletCreateSessionRequested,
  eip155Caip2ToHexChainId,
  isKnownDefaultChain,
  resolveChain,
} from "../src/chainRegistry";

describe("addressFromAccountId", () => {
  it("extracts a Solana address from CAIP-10", () => {
    expect(
      addressFromAccountId(
        "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
      ),
    ).toBe("9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz");
  });

  it("normalises EVM hex to 0x form", () => {
    const a = addressFromAccountId(
      "eip155:1:0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf",
    );
    expect(a).toBe("0x2b5ad5c4795c026514f8317c7a2e0e0bb0cd9cef");
  });

  it("returns token for too-few segments", () => {
    expect(addressFromAccountId("no-colons")).toBe("no-colons");
  });

  it("sameChainId trims and matches", () => {
    expect(sameChainId(" solana:devnet ", "solana:devnet")).toBe(true);
    expect(sameChainId("a", "b")).toBe(false);
  });
});

describe("chainRegistry", () => {
  it("resolves solana devnet with default RPC", () => {
    const r = resolveChain("solana:devnet", undefined);
    expect(r.family).toBe("solana");
    expect(r.rpcUrl).toContain("devnet");
  });

  it("applies rpc override for a known chain", () => {
    const r = resolveChain("solana:devnet", {
      "solana:devnet": "https://example.org/rpc",
    });
    expect(r.rpcUrl).toBe("https://example.org/rpc");
  });

  it("allows unknown CAIP-2 when an override is present", () => {
    const r = resolveChain("solana:custom", {
      "solana:custom": "https://custom.example/rpc",
    });
    expect(r.family).toBe("solana");
    expect(r.rpcUrl).toBe("https://custom.example/rpc");
  });

  it("throws for unknown chain without override", () => {
    expect(() => resolveChain("solana:unknown-xyz", undefined)).toThrow(
      /Unknown chain/,
    );
  });

  it("reports default membership", () => {
    expect(isKnownDefaultChain("solana:devnet")).toBe(true);
    expect(isKnownDefaultChain("solana:unknown")).toBe(false);
  });

  it("converts eip155 CAIP-2 to hex for eth_chainId", () => {
    expect(eip155Caip2ToHexChainId("eip155:1")).toBe("0x1");
    expect(eip155Caip2ToHexChainId("eip155:56")).toBe("0x38");
  });

  it("builds requested object for solana and evm", () => {
    expect(buildWalletCreateSessionRequested("solana:devnet")).toEqual({
      solanaChainId: "solana:devnet",
    });
    expect(buildWalletCreateSessionRequested("eip155:1")).toEqual({
      evmChainId: "eip155:1",
    });
  });

  it("rejects unsupported chain id in buildWalletCreateSessionRequested", () => {
    expect(() => buildWalletCreateSessionRequested("cosmos:foo")).toThrow(
      /Unsupported chain id/,
    );
  });

  it("rejects invalid eip155 in eip155Caip2ToHexChainId", () => {
    expect(() => eip155Caip2ToHexChainId("solana:devnet")).toThrow(
      /Not a valid eip155/,
    );
  });
});
