import { WalletSDK } from "../src/WalletSDK";
import { SDKErrorCode } from "../src/errors";
import type { HybridEncryptionResult } from "../src/crypto";
import { makeSdkFingerprint } from "../src/sessionPersistence";
import { Transaction } from "@solana/web3.js";

jest.mock("../src/chainConnection", () => ({
  validateResolvedChainRpc: jest.fn(async () => undefined),
}));

jest.mock("../src/solanaHelpers", () => ({
  toSolanaSignTransactionPayload: jest.fn(() => ({
    encodedTransaction: "base64-tx",
    options: { encoding: "base64" },
  })),
}));

jest.mock("../src/crypto", () => {
  const actual = jest.requireActual("../src/crypto");
  return {
    ...actual,
    encryptHybridJson: jest.fn(
      async (): Promise<HybridEncryptionResult> => ({
        encryptedKey: "enc-key",
        iv: "iv",
        authTag: "tag",
        ciphertext: "cipher",
      }),
    ),
  };
});

type CapturedRequest = {
  envelope: {
    clientId: string;
    payload: {
      method: string;
      params?: Record<string, unknown>;
    };
  };
  targetOrigin: string;
};

function baseConfig(targetWindow: Window) {
  return {
    walletOrigin: "https://wallet.example",
    targetWindow,
    timeoutMs: 80,
    dapp: { name: "Test dApp", url: "https://dapp.example" },
    chains: ["solana:devnet"] as const,
  };
}

function evmConfig(targetWindow: Window) {
  return {
    walletOrigin: "https://wallet.example",
    targetWindow,
    timeoutMs: 80,
    dapp: { name: "Test dApp", url: "https://dapp.example" },
    chains: ["eip155:1"] as const,
  };
}

function makeTargetWindow(calls: CapturedRequest[]): Window {
  return {
    postMessage: jest.fn((envelope, targetOrigin) => {
      calls.push({
        envelope: envelope as CapturedRequest["envelope"],
        targetOrigin: targetOrigin as string,
      });
    }),
  } as unknown as Window;
}

function makeSnapshotChecksum(payload: {
  v: number;
  clientId?: string;
  sessionId: string;
  chainId: string;
  accountId: string;
  address: string;
  expiresAt: number;
  rpcUrl: string;
  family: "solana" | "evm";
}): string {
  const input = [
    payload.v,
    payload.clientId ?? "",
    payload.sessionId,
    payload.chainId,
    payload.accountId,
    payload.address,
    payload.expiresAt,
    payload.rpcUrl,
    payload.family,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function emitDomEvent(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function waitForPostedMethod(
  calls: CapturedRequest[],
  method: string,
): Promise<CapturedRequest> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    const hit = calls.find((c) => c.envelope.payload.method === method);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for posted method: ${method}`);
}

async function waitForPostedMethods(
  calls: CapturedRequest[],
  method: string,
  minCount: number,
): Promise<CapturedRequest[]> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    const hits = calls.filter((c) => c.envelope.payload.method === method);
    if (hits.length >= minCount) return hits.slice(0, minCount);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for posted method (${method}) count >= ${minCount}`,
  );
}

describe("WalletSDK (integration)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
  });

  it("connects and signs a message with correlated native events", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = calls.find(
      (c) => c.envelope.payload.method === "wallet_createSession",
    );
    expect(connectRequest).toBeTruthy();

    const connectRequestId = String(
      connectRequest?.envelope.payload.params?.requestId,
    );
    const clientId = connectRequest!.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });

    const session = await connectPromise;
    expect(session.connected).toBe(true);
    expect(session.chainId).toBe("solana:devnet");
    expect(sdk.isConnected()).toBe(true);
    expect(sdk.useAccount().status).toBe("connected");

    const signPromise = sdk.signMessage({ message: "hello" });
    const signRequest = await waitForPostedMethod(calls, "solana_signMessage");

    emitDomEvent("signMessageResponse", {
      requestId: signRequest.envelope.payload.params!.requestId,
      clientId,
      sessionId: "session-public-key",
      signature: "signed-by-wallet",
    });

    await expect(signPromise).resolves.toEqual({
      signature: "signed-by-wallet",
    });
  });

  it("dedupes concurrent connect() calls for the same chain", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const p1 = sdk.connect("solana:devnet");
    const p2 = sdk.connect("solana:devnet");

    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );

    const createSessionRequests = calls.filter(
      (c) => c.envelope.payload.method === "wallet_createSession",
    );
    expect(createSessionRequests).toHaveLength(1);

    const connectRequestId = String(
      connectRequest.envelope.payload.params?.requestId,
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });

    await expect(p1).resolves.toMatchObject({
      connected: true,
      chainId: "solana:devnet",
    });
    await expect(p2).resolves.toMatchObject({
      connected: true,
      chainId: "solana:devnet",
    });
  });

  it("handles overlapping signMessage() calls with correct correlation", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    // Connect first
    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });
    await connectPromise;

    // Fire two sign requests in parallel.
    const p1 = sdk.signMessage({ message: "msg-1" });
    const p2 = sdk.signMessage({ message: "msg-2" });

    const signRequests = await waitForPostedMethods(
      calls,
      "solana_signMessage",
      2,
    );
    const signReq1 = signRequests[0];
    const signReq2 = signRequests[1];
    expect(signReq1).toBeTruthy();
    expect(signReq2).toBeTruthy();

    const reqId1 = String(signReq1!.envelope.payload.params?.requestId);
    const reqId2 = String(signReq2!.envelope.payload.params?.requestId);

    // Emit responses in reverse order to prove requestId correlation.
    emitDomEvent("signMessageResponse", {
      requestId: reqId2,
      clientId,
      sessionId: "session-public-key",
      signature: "sig-2",
    });
    emitDomEvent("signMessageResponse", {
      requestId: reqId1,
      clientId,
      sessionId: "session-public-key",
      signature: "sig-1",
    });

    const results = await Promise.all([p1, p2]);
    const sigs = results
      .map((r) => ("signature" in r ? r.signature : null))
      .filter((x): x is string => x !== null);
    expect(new Set(sigs)).toEqual(new Set(["sig-1", "sig-2"]));
  });

  it("rejects signMessage when native sends onRejectResponse", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = calls.find(
      (c) => c.envelope.payload.method === "wallet_createSession",
    )!;
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });
    await connectPromise;

    const signPromise = sdk.signMessage({ message: "hello" });
    const signRequest = await waitForPostedMethod(calls, "solana_signMessage");

    emitDomEvent("onRejectResponse", {
      requestId: signRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      message: "User denied request",
      code: "USER_CANCEL",
    });

    await expect(signPromise).rejects.toMatchObject({
      code: SDKErrorCode.USER_REJECTED,
      message: "User denied request",
    });
  });

  it("does not accept forged signMessageResponse with mismatched correlation fields", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = calls.find(
      (c) => c.envelope.payload.method === "wallet_createSession",
    )!;
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });
    await connectPromise;

    const signPromise = sdk.signMessage({ message: "hello" });
    const signRequest = await waitForPostedMethod(calls, "solana_signMessage");

    emitDomEvent("signMessageResponse", {
      requestId: "wrong-request-id",
      clientId,
      sessionId: "session-public-key",
      signature: "forged-1",
    });
    emitDomEvent("signMessageResponse", {
      requestId: signRequest.envelope.payload.params?.requestId,
      clientId: "wrong-client-id",
      sessionId: "session-public-key",
      signature: "forged-2",
    });
    emitDomEvent("signMessageResponse", {
      requestId: signRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "wrong-session-id",
      signature: "forged-3",
    });

    await expect(signPromise).rejects.toMatchObject({
      code: SDKErrorCode.TIMEOUT,
    });
  });

  it("disconnect clears local session and notifies native wallet", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });
    await connectPromise;
    expect(sdk.isConnected()).toBe(true);

    sdk.disconnect();

    expect(sdk.isConnected()).toBe(false);
    expect(sdk.useAccount()).toEqual({
      address: null,
      isConnected: false,
      caipAddress: null,
      status: "disconnected",
    });

    const disconnectRequest = await waitForPostedMethod(
      calls,
      "wallet_disconnect",
    );
    expect(disconnectRequest.envelope.payload.params?.sessionId).toBe(
      "session-public-key",
    );
  });

  it("rejects connect on chain ids outside constructor allow-list", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    await expect(sdk.connect("eip155:1")).rejects.toMatchObject({
      code: SDKErrorCode.CHAIN_NOT_ALLOWED,
    });
    expect(
      calls.some((c) => c.envelope.payload.method === "wallet_createSession"),
    ).toBe(false);
  });

  it("blocks critical operations in strict mode", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK({
      ...baseConfig(makeTargetWindow(calls)),
      securityMode: "strict",
    });

    await expect(sdk.connect("solana:devnet")).rejects.toMatchObject({
      code: SDKErrorCode.INVALID_CONFIG,
    });
  });

  it("restores a valid persisted session without requesting a new native session", async () => {
    const calls: CapturedRequest[] = [];
    const cfg = {
      ...baseConfig(makeTargetWindow(calls)),
      persistSession: true as const,
    };
    const fingerprint = makeSdkFingerprint(cfg.dapp.url, cfg.chains);
    const snapshot = {
      v: 1,
      clientId: "persisted-client-id",
      sessionId: "persisted-session-id",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
      address: "9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
      expiresAt: Date.now() + 60_000,
      rpcUrl: "https://api.devnet.solana.com",
      family: "solana" as const,
    };

    sessionStorage.setItem(
      `outlaw.wbsdk.sess.v1::${fingerprint}`,
      JSON.stringify({
        ...snapshot,
        checksum: makeSnapshotChecksum(snapshot),
      }),
    );

    const sdk = new WalletSDK(cfg);
    const session = await sdk.connect("solana:devnet");

    expect(session.address).toBe("9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz");
    expect(
      calls.some((c) => c.envelope.payload.method === "wallet_createSession"),
    ).toBe(false);
  });

  it("ignores malformed persisted snapshot and performs a fresh connect handshake", async () => {
    const calls: CapturedRequest[] = [];
    const cfg = {
      ...baseConfig(makeTargetWindow(calls)),
      persistSession: true as const,
    };
    const fingerprint = makeSdkFingerprint(cfg.dapp.url, cfg.chains);

    sessionStorage.setItem(
      `outlaw.wbsdk.sess.v1::${fingerprint}`,
      JSON.stringify({
        v: 1,
        clientId: "bad-client-id",
        sessionId: "attacker-session-id",
        chainId: "solana:devnet",
        accountId: "",
        address: "attacker-address",
        expiresAt: Date.now() + 60_000,
        rpcUrl: "https://api.devnet.solana.com",
        family: "solana",
        // missing checksum => rejected and cleared
      }),
    );

    const sdk = new WalletSDK(cfg);
    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId: connectRequest.envelope.clientId,
      sessionId: "new-session-id",
      chainId: "solana:devnet",
      accountId: "solana:devnet:7fQ6B6a9x8QQYjpjJg3YQ1m1VkYKgM4J91xK5K2f1EgA",
    });

    const session = await connectPromise;
    expect(session.address).toBe(
      "7fQ6B6a9x8QQYjpjJg3YQ1m1VkYKgM4J91xK5K2f1EgA",
    );
  });

  it("signs and sends a Solana transaction for an active session", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(baseConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("solana:devnet");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      chainId: "solana:devnet",
      accountId: "solana:devnet:9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz",
    });
    await connectPromise;

    const transaction = new Transaction();

    const txPromise = sdk.signAndSendTransaction({
      transaction,
    });
    const txRequest = await waitForPostedMethod(
      calls,
      "solana_signTransaction",
    );

    emitDomEvent("signAndSendTransactionResponse", {
      requestId: txRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "session-public-key",
      signature: "solana-tx-signature",
    });

    await expect(txPromise).resolves.toEqual({
      signature: "solana-tx-signature",
    });
  });

  it("connects on eip155 and signs message via personal_sign", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(evmConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("eip155:1");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      chainId: "eip155:1",
      accountId: "eip155:1:0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf",
    });

    const session = await connectPromise;
    expect(session.chainId).toBe("eip155:1");
    expect(session.address).toBe("0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf");

    const signPromise = sdk.signMessage({ message: "hello-evm" });
    const signRequest = await waitForPostedMethod(calls, "personal_sign");

    emitDomEvent("signMessageResponse", {
      requestId: signRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      signature: "0xevm-signature",
    });

    await expect(signPromise).resolves.toEqual({
      signature: "0xevm-signature",
    });
  });

  it("signs EIP-712 typedData via eth_signTypedData_v4", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(evmConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("eip155:1");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      chainId: "eip155:1",
      accountId: "eip155:1:0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf",
    });
    await connectPromise;

    const signPromise = sdk.signMessage({
      typedData: {
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Mail: [{ name: "contents", type: "string" }],
        },
        primaryType: "Mail",
        domain: { name: "Outlaw" },
        message: { contents: "hello typed data" },
      },
    });
    const signRequest = await waitForPostedMethod(
      calls,
      "eth_signTypedData_v4",
    );

    emitDomEvent("signMessageResponse", {
      requestId: signRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      signature: "0xtyped-signature",
    });

    await expect(signPromise).resolves.toEqual({
      signature: "0xtyped-signature",
    });
  });

  it("signs and sends an EVM transaction and returns hash", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(evmConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("eip155:1");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      chainId: "eip155:1",
      accountId: "eip155:1:0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf",
    });
    await connectPromise;

    const txPromise = sdk.signAndSendTransaction({
      from: "0x2b5ad5c4795c026514f8317c7a2e0e0bb0cd9cef",
      to: "0x6fC21092DA55B392b045ed78F4732bff3C580e2c",
      value: "0x1",
    });
    const txRequest = await waitForPostedMethod(calls, "eth_sendTransaction");

    emitDomEvent("signAndSendTransactionResponse", {
      requestId: txRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      hash: "0xtxhash",
    });

    await expect(txPromise).resolves.toEqual({ hash: "0xtxhash" });
  });

  it("does not accept forged EVM transaction responses with mismatched correlation fields", async () => {
    const calls: CapturedRequest[] = [];
    const sdk = new WalletSDK(evmConfig(makeTargetWindow(calls)));

    const connectPromise = sdk.connect("eip155:1");
    const connectRequest = await waitForPostedMethod(
      calls,
      "wallet_createSession",
    );
    const clientId = connectRequest.envelope.clientId;

    emitDomEvent("onWalletSession", {
      requestId: connectRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "evm-session-id",
      chainId: "eip155:1",
      accountId: "eip155:1:0x2B5AD5c4795c026514F8317c7a2E0E0bB0cD9cEf",
    });
    await connectPromise;

    const txPromise = sdk.signAndSendTransaction({
      from: "0x2b5ad5c4795c026514f8317c7a2e0e0bb0cd9cef",
      to: "0x6fC21092DA55B392b045ed78F4732bff3C580e2c",
      value: "0x1",
    });
    const txRequest = await waitForPostedMethod(calls, "eth_sendTransaction");

    emitDomEvent("signAndSendTransactionResponse", {
      requestId: "wrong-request-id",
      clientId,
      sessionId: "evm-session-id",
      hash: "0xforged-1",
    });
    emitDomEvent("signAndSendTransactionResponse", {
      requestId: txRequest.envelope.payload.params?.requestId,
      clientId: "wrong-client-id",
      sessionId: "evm-session-id",
      hash: "0xforged-2",
    });
    emitDomEvent("signAndSendTransactionResponse", {
      requestId: txRequest.envelope.payload.params?.requestId,
      clientId,
      sessionId: "wrong-session-id",
      hash: "0xforged-3",
    });

    await expect(txPromise).rejects.toMatchObject({
      code: SDKErrorCode.TIMEOUT,
    });
  });
});
