# `@outlaw/webview-bridge-sdk`

Promise-based WebView wallet SDK for Outlaw dApps.  
Integrate once, then use a simple flow: **create SDK -> read `useAccount()` -> connect if needed -> sign -> disconnect**.

[![npm](https://img.shields.io/npm/v/@outlaw/webview-bridge-sdk)](https://npmjs.com/package/@outlaw/webview-bridge-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## Installation

```bash
npm install @outlaw/webview-bridge-sdk
```

---

## dApp integration flow

### 1) Create the SDK once

```ts
import { WalletSDK } from "@outlaw/webview-bridge-sdk";

const sdk = new WalletSDK({
  dapp: {
    name: "My dApp",
    url: "https://my-dapp.com",
    description: "Optional",
    icon: "https://example.com/icon.png",
  },
  chains: ["solana:devnet"], // allow-list
  walletOrigin: "https://wallet.your-app.com", // recommended in production
  timeoutMs: 30_000,
  debug: false,
  sessionTtlMs: 24 * 60 * 60 * 1000, // default 24h
  persistSession: true, // default true
  chainRpcOverrides: {
    // "solana:devnet": "https://your-rpc.example",
  },
});
```

`connect(chainId)` only accepts chain IDs configured in `chains`.

---

### 2) Drive UI state with `useAccount()`

```ts
const { address, isConnected, caipAddress, status } = sdk.useAccount();
```

Returned shape:

- `address: string | null`
- `isConnected: boolean`
- `caipAddress: string | null` (`<chainId>:<address>`)
- `status: "connected" | "disconnected"`

Example guard:

```ts
const account = sdk.useAccount();

if (!account.isConnected) {
  await sdk.connect("solana:devnet");
}
```

---

### 3) Sign once connected

```ts
const { signature: messageSignature } = await sdk.signMessage({
  message: "Hello, Outlaw!",
});
```

```ts
import { Transaction } from "@solana/web3.js";

const tx = new Transaction();
// add instructions...

const { signature: txSignature } = await sdk.signAndSendTransaction({
  transaction: tx,
});
```

---

### 4) Disconnect on logout/teardown

```ts
sdk.disconnect();
```

---

## Runtime sequence

1. `new WalletSDK(...)`
2. `sdk.useAccount()`
3. If disconnected, `await sdk.connect(chainId)`
4. `sdk.useAccount()` again to render connected state
5. User actions:
   - `await sdk.signMessage(...)`
   - `await sdk.signAndSendTransaction(...)`
6. On app logout/teardown: `sdk.disconnect()`

---

## Public API (current)

| Method                                    | Purpose                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `connect(chainId: string)`                | Creates or restores a session for an allowed chain and returns `{ address, chainId, connected, expiresAt }`. |
| `useAccount()`                            | Unified UI guard state: `{ address, isConnected, caipAddress, status }`.                                     |
| `isConnected()`                           | Boolean connected check.                                                                                     |
| `signMessage({ message })`                | Signs UTF-8 string or `Uint8Array`.                                                                          |
| `signAndSendTransaction({ transaction })` | Signs and submits Solana transaction payload.                                                                |
| `disconnect()`                            | Clears session, pending requests, and notifies wallet disconnect.                                            |

Security note: encryption key material (`sessionId`) is never exposed to dApp code.

---

## Native bridge event contract

Native layer must dispatch these DOM events on `window`:

- `onWalletSession` with `{ sessionId, chainId, accountId }`
- `signMessageResponse` with `{ signature }`
- `signAndSendTransactionResponse` with `{ signature }`

The SDK listens for these and resolves each API call.

---

## Errors to handle

- `NOT_CONNECTED`: connect first
- `SESSION_EXPIRED`: reconnect
- `CHAIN_NOT_ALLOWED`: chain not in constructor allow-list
- `TIMEOUT`: wallet/native did not respond in time
- `INVALID_EVENT`: returned chain mismatch
- `INVALID_PAYLOAD` / `ENCRYPTION_FAILED`: payload or crypto issue
- `INVALID_CONFIG`: invalid SDK constructor config
