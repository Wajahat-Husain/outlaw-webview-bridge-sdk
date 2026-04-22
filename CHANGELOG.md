# Changelog

All notable changes to `@outlaw/webview-bridge-sdk` will be documented here.

This project follows [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

---

## [1.0.0] — 2026-04-14

### Added

- **`OutlawBridge`** — primary SDK class with full Solana and EVM method support
- **`WalletBridge`** — low-level JSON-RPC 2.0 transport with typed method registry
- **`SessionManager`** — in-memory session lifecycle with TTL-based expiry
- **`ReplayGuard`** — rolling-window cache for replay attack prevention
- **`TypedEventEmitter`** — zero-dependency, fully-typed event system
- **`encryptPayload` / `decryptPayload`** — XSalsa20-Poly1305 session encryption via TweetNaCl
- **`BridgeError`** — typed error class with helper predicates (`isUserRejection`, `isTimeout`, `isSessionExpired`)
- **`useOutlawBridge`** — React hook for managed bridge + session state
- Full ESM + CJS dual-package output
- TypeScript declaration files (`.d.ts`) with source maps
- Comprehensive test suite (unit + integration)

### Solana Methods

- `signMessage` — Ed25519 message signing
- `signTransaction` — Transaction signing
- `sendTransaction` — Sign + submit to RPC

### EVM Methods

- `personalSign` — secp256k1 message signing
- `sendEvmTransaction` — RLP-encoded transaction submission
- `requestAccounts` — wallet address retrieval

### Security

- Origin validation on every inbound `postMessage`
- Replay attack protection via UUID deduplication window
- Poly1305 MAC authentication on all encrypted payloads
- Zero private key exposure — keys never enter the Web layer
