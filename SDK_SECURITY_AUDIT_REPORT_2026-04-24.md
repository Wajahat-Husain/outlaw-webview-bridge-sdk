# SDK Security Audit & Vulnerability Assessment Report

**Date:** April 24, 2026  
**Status:** PRE-PUBLISH  
**Package:** `@outlaw/webview-bridge-sdk`  
**Version:** `2.0.0`  
**Auditor:** GPT-5 Codex

---

## 1. Executive Summary

This document provides a strict pre-publish security review of the `@outlaw/webview-bridge-sdk` codebase. The audit focused on wallet session handling, WebView bridge communication, multi-chain request flow integrity, cryptographic handling, dependency hygiene, and release readiness for hostile production environments.

### Final Verdict

**Not ready for production publish.**

The SDK has a critical trust-boundary weakness: outbound wallet communication uses `postMessage`, but inbound approval/session/signing results are accepted through unauthenticated DOM custom events. In an untrusted dApp, XSS’d page, or third-party script environment, a malicious actor can spoof wallet state and signing outcomes.

### Security Score

**34 / 100**  
**Grade:** `F`

### Issues Found

- **Critical:** 1
- **High:** 4
- **Medium:** 4
- **Low:** 2
- **Total:** 11

---

## 2. Audit Scope & Methodology

The audit was performed using:

- Manual secure code review
- Adversarial threat modeling
- Static review of trust boundaries and message flows
- Dependency tree inspection
- Local validation with:
  - `npm audit --json`
  - `npm test -- --runInBand`
  - `npm run typecheck`

### Review Scope

- Full SDK source under `src/`
- Tests and release posture
- Wallet interaction logic
- WebView / bridge communication
- Solana + EVM multi-chain handling
- Session persistence and recovery
- Build and prepublish scripts
- Runtime and transitive dependencies

### Validation Results

- `npm audit --json`: **0 known advisories** as of **April 24, 2026**
- `npm run typecheck`: **Pass**
- `npm test -- --runInBand`: **Fail**

---

## 3. Architecture Security Assessment

### Is the SDK safe for embedding in untrusted dApps?

**No.**

The current design assumes the page environment is trustworthy. That assumption is unsafe for production wallet SDK usage. Any same-page script can dispatch the SDK’s expected custom events and satisfy pending wallet requests without native wallet participation.

### Can a malicious dApp exploit wallet communication?

**Yes.**

A malicious dApp, compromised analytics tag, injected ad script, or XSS payload can:

- Forge `onWalletSession`
- Forge `signMessageResponse`
- Forge `signAndSendTransactionResponse`
- Force false rejections using `onRejectResponse`
- Poison persisted session state

### Are transaction payloads tamper-proof?

**No.**

Payloads are encrypted outbound, but inbound resolution is not cryptographically bound to the original request. The response channel is not authenticated and does not include request correlation or replay protection.

### Are signing flows secure and verifiable?

**No.**

The EVM path uses `eth_sign`, lacks nonce/domain separation, and accepts uncorrelated responses. The Solana path is stronger on payload encapsulation but still relies on an unauthenticated inbound event channel.

---

## 4. Vulnerability Findings

### VULN-001: Unauthenticated native-event channel allows session and signature spoofing

- **Severity:** 🔴 CRITICAL
- **Location:**
  - [src/RequestManager.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\RequestManager.ts:85)
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:176)

#### Description

The SDK resolves wallet actions from DOM custom events on `window`:

```ts
window.addEventListener(eventName, listener);
...
resolve(detail as NativeEventPayloadMap[K]);
```

The only validation performed is shape checking of `detail`. There is no verification of:

- message origin
- sender identity
- request ID
- session binding
- cryptographic authenticity

#### Impact

Any script executing in the dApp page can spoof wallet session establishment or signing results. This fully breaks the wallet trust model.

#### Exploitation Scenario

An attacker injects:

```ts
window.dispatchEvent(
  new CustomEvent("onWalletSession", {
    detail: {
      id: "fake",
      sessionId: "<attacker-controlled key>",
      chainId: "eip155:1",
      accountId: "eip155:1:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    },
  }),
);

window.dispatchEvent(
  new CustomEvent("signMessageResponse", {
    detail: { signature: "0xfakesignature" },
  }),
);
```

The dApp can now believe the wallet approved an action that never reached the wallet.

#### Remediation

- Remove `CustomEvent`-based resolution for security-sensitive flows
- Return all wallet responses over authenticated `postMessage`
- Bind responses to:
  - `origin`
  - `source`
  - `clientId`
  - `requestId`
  - `sessionId`
  - monotonic nonce/counter

#### Recommended Secure Pattern

```ts
type WalletResponseEnvelope = {
  type: "OUTLAW_BRIDGE_RESPONSE";
  clientId: string;
  requestId: string;
  sessionId: string;
  payload: unknown;
};
```

Resolve only if all fields match the in-flight request.

---

### VULN-002: No request correlation or replay protection on async wallet responses

- **Severity:** 🔴 HIGH
- **Location:**
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:459)
  - [src/RequestManager.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\RequestManager.ts:68)

#### Description

The SDK tracks only one pending request per event type:

```ts
private readonly pending = new Map<NativeEventName, PendingSlot<unknown>>();
```

Responses are matched only by event name, not by request ID.

#### Impact

- Stale responses can satisfy future requests
- Parallel or overlapping flows can cross-resolve
- Replay attacks are possible
- An attacker can pre-fire or race responses

#### Remediation

- Generate a `requestId` for every wallet action
- Include it in the encrypted payload and outer transport metadata
- Require the wallet response to include the same `requestId`
- Reject duplicate or already-consumed IDs

---

### VULN-003: Insecure wallet origin autodetection enables MITM or bridge misdirection

- **Severity:** 🔴 HIGH
- **Location:**
  - [src/Bridge.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\Bridge.ts:34)
  - [src/types.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\types.ts:88)

#### Description

When `walletOrigin` is omitted, the SDK auto-detects it from:

- `?walletOrigin=` query param
- `document.referrer`
- `window.location.origin`

#### Impact

This allows unsafe or attacker-influenced routing of wallet traffic in hostile embedding setups.

#### Remediation

- Require explicit `walletOrigin` in production
- Enforce `https:` scheme
- Reject query-param origin configuration for production builds
- Consider allow-listing known wallet origins

#### Example Hardened Validation

```ts
function assertTrustedOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("walletOrigin must use https");
  }
  return url.origin;
}
```

---

### VULN-004: Session fixation and tampering via trusted `sessionStorage`

- **Severity:** 🔴 HIGH
- **Location:**
  - [src/sessionPersistence.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\sessionPersistence.ts:38)
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:157)

#### Description

Persisted session state is loaded from `sessionStorage` and trusted without integrity verification.

Stored fields include:

- `sessionId`
- `chainId`
- `accountId`
- `address`
- `expiresAt`
- `rpcUrl`
- `family`

#### Impact

Any same-origin script can:

- plant a forged session
- alter chain/account identity
- extend expiry
- replace the session encryption key material

#### Remediation

- Disable `persistSession` by default
- Never persist raw trusted session fields from the wallet
- Use only wallet-issued opaque resumable tokens
- Bind resume tokens to:
  - dApp origin
  - wallet origin
  - account
  - expiry
  - signature/MAC

---

### VULN-005: Unsafe EVM signing method (`eth_sign`) with no domain separation

- **Severity:** 🔴 HIGH
- **Location:** [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:385)

#### Description

The EVM signing flow uses:

```ts
this.bridge.notify("eth_sign", {
  encryptedPayload,
  requested: buildWalletCreateSessionRequested(s.chainId),
});
```

`eth_sign` is broadly considered unsafe for end-user signing UX because it signs opaque bytes and is easier to abuse in phishing-style flows.

#### Impact

- User cannot reliably verify what is being signed
- Signatures may be reused in unintended contexts
- Backend verification becomes easier to misuse

#### Remediation

- Use `personal_sign` for simple human-readable messages
- Use EIP-712 typed data for structured signing
- Require fields such as:
  - domain
  - uri
  - chainId
  - nonce
  - issuedAt
  - expirationTime

---

### VULN-006: Missing strict validation for CAIP-2, accountId, and EVM transaction fields

- **Severity:** 🟠 MEDIUM
- **Location:**
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:535)
  - [src/accountId.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\accountId.ts:10)
  - [src/types.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\types.ts:64)

#### Description

Validation is prefix-based and permissive:

```ts
!c.startsWith("solana:") && !c.startsWith("eip155:");
```

`accountId` parsing is based on split/join rather than strict CAIP-10 validation. EVM transaction fields are accepted as arbitrary strings.

#### Impact

Malformed payloads may reach the wallet/native layer, and dApps may rely on data that has not been properly normalized or bound to the active session.

#### Remediation

Implement strict validators for:

- CAIP-2 chain IDs
- CAIP-10 account IDs
- EVM addresses
- EVM hex quantities
- `from` must equal active session address
- optional `to`, `data`, `nonce`, `gasLimit`, `gasPrice`, `value`

---

### VULN-007: No nonce or replay-resistant signing envelope

- **Severity:** 🟠 MEDIUM
- **Location:**
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:304)
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:385)

#### Description

The SDK signs raw message payloads but does not require:

- nonce
- expiration
- audience
- request origin
- statement domain

#### Impact

Valid signatures are easier to replay across sessions, services, or application contexts.

#### Remediation

Add first-class structured signing helpers for:

- SIWE-like EVM authentication
- Solana structured sign-in challenge

Require nonce-based backend verification.

---

### VULN-008: Sensitive session internals logged in debug mode

- **Severity:** 🟠 MEDIUM
- **Location:** [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:203)

#### Description

The SDK logs the full internal session object:

```ts
this.logger.i(`internal session set: ${JSON.stringify(this.internal)}`);
```

This includes `sessionId`, which is treated as wallet-provided public key material used by the encryption layer.

#### Impact

Sensitive internal state may leak into:

- browser devtools
- log aggregators
- screen recordings
- support bundles

#### Remediation

- Never log `sessionId`
- Redact account/session internals
- Make warnings/errors opt-in for browser environments where possible

---

### VULN-009: RPC override URLs are not restricted to secure transports

- **Severity:** 🟡 LOW
- **Location:**
  - [src/chainRegistry.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\chainRegistry.ts:70)
  - [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:535)

#### Description

Custom RPC endpoints can be supplied without scheme hardening.

#### Impact

Consumers may accidentally configure insecure or hostile endpoints, creating privacy and MITM risk.

#### Remediation

- Enforce `https:` by default
- Explicitly reject insecure schemes in production
- Document trust implications of custom RPCs

---

### VULN-010: Release assurance is weak because critical tests are disabled

- **Severity:** 🟡 LOW
- **Location:** [tests/WalletSDK.test.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\tests\WalletSDK.test.ts:1)

#### Description

The integration suite for wallet/session behavior is commented out and replaced by a placeholder:

```ts
describe("WalletSDK (integration)", () => {
  it("is pending — legacy tests are commented out below", () => {
    expect(true).toBe(true);
  });
});
```

`npm test` also currently fails on active expectations in `tests/accountIdChainRegistry.test.ts`.

#### Impact

Critical regressions in transport security and session handling are likely to ship unnoticed.

#### Remediation

- Re-enable integration tests
- Add malicious-event spoofing tests
- Add replay and concurrency tests
- Fail CI if tests are skipped or commented out

---

### VULN-011: Public API and tests are inconsistent, increasing release risk

- **Severity:** 🟠 MEDIUM
- **Location:**
  - [src/accountId.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\accountId.ts:10)
  - [src/chainRegistry.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\chainRegistry.ts:112)
  - [tests/accountIdChainRegistry.test.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\tests\accountIdChainRegistry.test.ts:18)

#### Description

Current tests fail because implementation and expected behavior differ. That includes:

- EVM address normalization expectations
- `buildWalletCreateSessionRequested()` shape expectations
- unsupported chain error message expectations

#### Impact

Security-critical semantics are not stable enough for a public release and may be misunderstood by integrators.

#### Remediation

- Align tests and implementation
- Freeze semantics for chain/account normalization
- Add explicit compatibility notes before publish

---

## 5. Exact Code Snippets of Concern

### Unauthenticated event listener

From [src/RequestManager.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\RequestManager.ts:92):

```ts
const listener: EventListener = (ev: Event) => {
  const detail = (ev as CustomEvent<unknown>).detail;
  ...
  if (!this.validateEventDetail(eventName, detail)) {
    return;
  }
  this.cleanup(eventName);
  resolve(detail as NativeEventPayloadMap[K]);
};
```

### Session creation trust boundary

From [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:176):

```ts
const sessionPromise = this.waitForEventOrReject("onWalletSession");
this.bridge.send("wallet_createSession", { requested });
const event = await sessionPromise;
```

### Trusted session rehydration

From [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:157):

```ts
const snap = loadPersistedSession(this.storageFingerprint);
if (snap && sameChainId(snap.chainId, id) && Date.now() < snap.expiresAt) {
  this.applySnapshot(snap);
  this.scheduleExpiry();
  return this.toPublic();
}
```

### Unsafe EVM signing method

From [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts:406):

```ts
this.bridge.notify("eth_sign", {
  encryptedPayload,
  requested: buildWalletCreateSessionRequested(s.chainId),
});
```

---

## 6. Dependency Security Review

### Direct Production Dependencies

| Package           | Version   | Notes                                                                               |
| ----------------- | --------- | ----------------------------------------------------------------------------------- |
| `@solana/web3.js` | `^1.98.4` | Large dependency surface; common and legitimate, but should be pinned and monitored |
| `bs58`            | `^6.0.0`  | Acceptable                                                                          |
| `prettier`        | `^3.8.3`  | Should not be a production dependency                                               |

### Peer Dependencies

| Package     | Version  | Notes                                                              |
| ----------- | -------- | ------------------------------------------------------------------ |
| `tweetnacl` | `^1.0.3` | Present but not meaningfully used in current trust-boundary design |

### Audit Status

`npm audit --json` reported:

- `critical: 0`
- `high: 0`
- `moderate: 0`
- `low: 0`

### Dependency Risk Observations

- No known advisories at audit time
- `prettier` should move to `devDependencies`
- Consider pinning exact versions before public registry release
- Consider enabling lockfile integrity monitoring in CI

---

## 7. Build & Distribution Pipeline Review

### Observations

- `prepublishOnly` runs:
  - `npm run typecheck`
  - `npm run build`
  - `npm run test`
- `npm test` currently fails
- No GitHub Actions or other CI workflow files were found during repo inspection
- `npm pack --dry-run` could not be conclusively validated due local `EPERM` cache permission issues

### Risks

- Broken tests weaken release gating
- No visible CI security controls
- No visible artifact inspection step
- No visible provenance/signing/release attestation

### Recommendations

1. Add CI with mandatory:
   - typecheck
   - unit/integration tests
   - lint
   - dependency audit
   - `npm pack --json` artifact verification
2. Add secret scanning and dependency review
3. Publish with provenance if supported by your release environment

---

## 8. Recommended Remediation Roadmap

### Immediate Blockers Before Publish

1. Replace unauthenticated DOM custom-event response handling.
2. Require authenticated request/response correlation.
3. Remove or redesign session persistence.
4. Replace `eth_sign` with safer signing methods.
5. Add strict validation for chain/account/transaction payloads.
6. Restore and expand the security-sensitive test suite.

### Near-Term Hardening

1. Redact sensitive logs.
2. Enforce secure `walletOrigin` and RPC URL schemes.
3. Add replay protection and nonce enforcement.
4. Add structured sign-in helpers for EVM and Solana.

### Long-Term Improvements

1. Add formal protocol documentation for wallet-native bridge semantics.
2. Threat-model hostile dApps explicitly in README/docs.
3. Add fuzz tests for malformed events and payloads.
4. Add concurrency tests for parallel sign/connect flows.

---

## 9. Production Readiness Verdict

### Final Score

**34 / 100**

### Final Grade

**F**

### Ready for Production

**No**

### Attestation

This SDK should **not** be published to npm for real-funds production use in its current state. The response/authentication model is not robust enough for hostile web environments, and the release assurance posture is incomplete.

---

## 10. Appendix: Commands Run

```bash
npm audit --json
npm test -- --runInBand
npm run typecheck
```

### Command Results

- `npm audit --json`: passed with no known advisories
- `npm run typecheck`: passed
- `npm test -- --runInBand`: failed

---

## 11. Appendix: Files Reviewed

- [src/WalletSDK.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\WalletSDK.ts)
- [src/Bridge.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\Bridge.ts)
- [src/RequestManager.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\RequestManager.ts)
- [src/sessionPersistence.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\sessionPersistence.ts)
- [src/chainRegistry.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\chainRegistry.ts)
- [src/chainConnection.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\chainConnection.ts)
- [src/accountId.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\accountId.ts)
- [src/crypto.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\crypto.ts)
- [src/types.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\src\types.ts)
- [tests/WalletSDK.test.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\tests\WalletSDK.test.ts)
- [tests/accountIdChainRegistry.test.ts](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\tests\accountIdChainRegistry.test.ts)
- [package.json](D:\GITHUB REPOS\outlaw-webview-bridge-sdk\package.json)
