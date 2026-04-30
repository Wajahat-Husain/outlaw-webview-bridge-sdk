# `@outlaw/webview-bridge-sdk`

Promise-based WebView wallet SDK for Outlaw dApps with Solana and EVM support.

[![npm](https://img.shields.io/npm/v/@outlaw/webview-bridge-sdk)](https://npmjs.com/package/@outlaw/webview-bridge-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## Installation

```bash
npm install @outlaw/webview-bridge-sdk
```

---

## Quick start

```ts
import { WalletSDK } from "@outlaw/webview-bridge-sdk";

const sdk = new WalletSDK({
  dapp: {
    name: "My dApp",
    url: "https://my-dapp.com",
    description: "Optional",
    icon: "https://example.com/icon.png",
  },
  // CAIP-2 allow-list. You can include both families.
  chains: ["solana:devnet", "eip155:1"],
  walletOrigin: "https://wallet.your-app.com", // required
  timeoutMs: 30_000,
  debug: false,
  sessionTtlMs: 24 * 60 * 60 * 1000, // default: 24h
  persistSession: false, // default: false (opt-in only)
  rpcValidation: "chainIdOnly", // default: "chainIdOnly" ("off" | "chainIdOnly" | "full")
  // Optional production telemetry (omit or set false to disable)
  metrics: true, // when true, emits lightweight telemetry via console.log
  chainRpcOverrides: {
    // "eip155:1": "https://your-ethereum-rpc.example",
    // "solana:devnet": "https://your-solana-rpc.example",
  },
});
```

`connect(chainId)` only accepts chain IDs included in `chains`.

`rpcValidation` modes:

- `off`: skip RPC probe during `connect()`
- `chainIdOnly` (default): verify EVM `eth_chainId`; skip Solana probe
- `full`: verify EVM `eth_chainId` and Solana `getVersion()`

`metrics` hook (optional):

- `connect_latency`: `{ type: "connect_latency", chainId, latencyMs, success }`
- `session_restore`: `{ type: "session_restore", chainId, hit }`
- `timeout`: `{ type: "timeout", operation: "connect" | "signMessage" | "signAndSendTransaction", chainId?, latencyMs }`
- `rejection`: `{ type: "rejection", operation, chainId?, latencyMs, code?, message? }`

---

## Connection + UI state

```ts
const account = sdk.useAccount();
// { address, isConnected, caipAddress, status }

if (!account.isConnected) {
  await sdk.connect("eip155:1"); // or "solana:devnet"
}
```

`useAccount()` returns:

- `address: string | null`
- `isConnected: boolean`
- `caipAddress: string | null` (format: `<chainId>:<address>`)
- `status: "connected" | "disconnected"`

---

## Solana usage

```ts
import { address } from "@solana/kit";

await sdk.connect("solana:devnet");

const signedMessage = await sdk.signMessage({
  message: "Hello Solana",
});
// -> { signature: string }

const tx = {
  feePayer: address("9xQeWvG819bN2pWk1jNf2pZxYvKpRqHvMnStUvWxYz"),
  recentBlockhash: "EETubP5AKHgjPAhzPAFcbfWfM6Bv3kNPHkQ6A5T6Rxy9",
  instructions: [],
  serializedTransaction: "base64-serialized-wire-transaction",
};

const signedTx = await sdk.signAndSendTransaction({
  transaction: tx,
});
// -> { signature: string }
```

---

## EVM usage

```ts
await sdk.connect("eip155:1");

const signedMessage = await sdk.signMessage({
  message: "Hello EVM",
});
// -> { signature: string }

const typedDataSig = await sdk.signMessage({
  typedData: {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Mail: [{ name: "contents", type: "string" }],
    },
    primaryType: "Mail",
    domain: { name: "Outlaw" },
    message: { contents: "Hello typed data" },
  },
});
// -> { signature: string }

const sent = await sdk.signAndSendTransaction({
  from: "0xYourAddress",
  to: "0xRecipientAddress",
  value: "0x2386f26fc10000", // 0.01 ETH (wei, hex)
  data: "0x",
});
// -> { hash: string } (wallets may also include signature in some implementations)
```

---

## Public API

- `connect(chainId: string): Promise<Session>`
  - Creates/restores a session for an allowed CAIP-2 chain.
  - Returns `{ address, chainId, connected, expiresAt }`.
- `useAccount(): AccountInfo`
  - Returns one-shot UI state `{ address, isConnected, caipAddress, status }`.
- `isConnected(): boolean`
  - Checks whether there is a valid, non-expired session.
- `signMessage(payload): Promise<WalletResponse>`
  - Solana payload: `{ message: string | Uint8Array }`
  - EVM payload: `{ message: string }`
- `signAndSendTransaction(payload): Promise<WalletResponse>`
  - Solana payload: `{ transaction: Solana transaction-like object }`
  - EVM payload: `{ from?, to?, value?, data?, gasLimit?, gasPrice?, nonce? }`
- `disconnect(): void`
  - Clears session state, cancels pending waits, and notifies native via `wallet_disconnect`.

`WalletResponse` is a union:

- `{ signature: string }` for message signatures and Solana transaction signing responses
- `{ hash: string }` for EVM transaction submission responses

Security note: `sessionId` (wallet-provided public key material used for encryption) stays internal to the SDK and is never exposed by the public API.

### Security contract

The SDK enforces a single, non-configurable security posture on all integrations:

- **`walletOrigin` is required** — the SDK throws `INVALID_CONFIG` at construction if it is absent.
- **`sessionId` is required on sign responses** — `signMessageResponse` and
  `signAndSendTransactionResponse` events must carry a `sessionId` that matches the bound
  session. Events without it are immediately rejected with `INVALID_EVENT`.
- **`requestId` + `clientId` correlation is always enforced** — every native response must
  match the originating request.

`persistSession` is opt-in and defaults to `false` to reduce `sessionStorage` exposure.

### Default chains and testnets

Built-in EVM testnet entries (e.g. Sepolia, Polygon Amoy, BNB Chain testnet) track common public RPCs. **End-of-life networks such as Goerli are not shipped as defaults.** To use an older or private testnet, supply the RPC in `chainRpcOverrides` and keep your allow-list in `chains` consistent with that network.

Current built-in CAIP-2 defaults:

- Solana: `solana:mainnet-beta`, `solana:devnet`, `solana:testnet`
- EVM: `eip155:1`, `eip155:11155111`, `eip155:56`, `eip155:97`, `eip155:137`, `eip155:80002`, `eip155:42161`, `eip155:10`, `eip155:8453`

---

## Native event contract

The SDK resolves requests from `window` DOM events dispatched by the native wallet layer:

- `onWalletSession` -> `{ sessionId, chainId, accountId }`
- `signMessageResponse` -> `{ signature }`
- `signAndSendTransactionResponse` -> `{ signature }` or `{ hash }`
- `onRejectResponse` -> `{ status?, message?, reason?, code? }`

For a response event to be accepted, correlation fields must match the initiating request:

- `requestId` must match
- `clientId` must match
- when present, `sessionId` must match

The SDK races success events against `onRejectResponse` and converts user rejections into `USER_REJECTED`.

---

## Common errors to handle

- `NOT_CONNECTED` - call `connect()` first
- `SESSION_EXPIRED` - session TTL elapsed; reconnect
- `CHAIN_NOT_ALLOWED` - requested chain not in constructor allow-list
- `TIMEOUT` - native layer did not answer in time
- `INVALID_EVENT` - wallet session event chain mismatch
- `INVALID_PAYLOAD` - malformed signing payload
- `ENCRYPTION_FAILED` - payload encryption failed
- `INVALID_CONFIG` - invalid SDK constructor config
- `USER_REJECTED` - user rejected in wallet UI
