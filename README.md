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
  walletOrigin: "https://wallet.your-app.com", // strongly recommended in production
  timeoutMs: 30_000,
  debug: false,
  sessionTtlMs: 24 * 60 * 60 * 1000, // default: 24h
  persistSession: true, // default: true
  chainRpcOverrides: {
    // "eip155:1": "https://your-ethereum-rpc.example",
    // "solana:devnet": "https://your-solana-rpc.example",
  },
});
```

`connect(chainId)` only accepts chain IDs included in `chains`.

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
import { Transaction } from "@solana/web3.js";

await sdk.connect("solana:devnet");

const signedMessage = await sdk.signMessage({
  message: "Hello Solana",
});
// -> { signature: string }

const tx = new Transaction();
// add instructions, feePayer, recentBlockhash...

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
  - Solana payload: `{ transaction: Transaction }`
  - EVM payload: `{ from?, to?, value?, data?, gasLimit?, gasPrice?, nonce? }`
- `disconnect(): void`
  - Clears session state, cancels pending waits, and notifies native via `wallet_disconnect`.

`WalletResponse` is a union:

- `{ signature: string }` for message signatures and Solana transaction signing responses
- `{ hash: string }` for EVM transaction submission responses

Security note: `sessionId` (wallet-provided public key material used for encryption) stays internal to the SDK and is never exposed by the public API.

---

## Native event contract

The SDK resolves requests from `window` DOM events dispatched by the native wallet layer:

- `onWalletSession` -> `{ sessionId, chainId, accountId }`
- `signMessageResponse` -> `{ signature }`
- `signAndSendTransactionResponse` -> `{ signature }` or `{ hash }`
- `onRejectResponse` -> `{ status?, message?, reason?, code? }`

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
