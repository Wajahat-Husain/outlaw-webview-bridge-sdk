# SDK Security Audit & Vulnerability Assessment Report

**Date:** April 24, 2026  
**Status:** INTERNAL / PRE-PUBLISH  
**Version:** 2.0.0  
**Auditor:** Codex 5.3 (AI Security Review)

---

## 1. Executive Summary

This document provides a comprehensive security review of the `@outlaw/webview-bridge-sdk` codebase. The primary goal of this audit was to identify potential attack vectors, injection vulnerabilities, transport trust issues, signing-flow weaknesses, and dependency risks prior to public NPM release.

### Security Score: **C (64/100)**

- **Total Issues Found:** 10
- **Critical/High Risks:** 4
- **Remediation Status:** Pending
- **Production Verdict:** **NOT READY FOR PRODUCTION**

**Top risk theme:** security-critical responses are accepted from unauthenticated DOM custom events, allowing forged wallet outcomes in hostile dApp environments.

---

## 2. Audit Scope & Methodology

The audit was conducted with:

- Static code review (all `src/*` modules)
- Manual adversarial threat modeling (hostile dApp + XSS assumptions)
- Dependency analysis (`npm audit --json`, full dependency tree)
- Build/release pipeline review (`package.json`, docs, test coverage posture)

**Review Areas:**

- Input/Output validation (CAIP-2, CAIP-10, payload format/shape)
- Bridge transport security (`postMessage`, event handling, correlation)
- Session lifecycle and persistence
- Solana + EVM signing and transaction paths
- Cryptography usage and replay/tampering resilience
- Supply-chain and release hardening

---

## 3. Vulnerability Findings

## [VULN-001] Unauthenticated DOM Event Channel for Security-Critical Responses

- **Severity:** 🔴 CRITICAL
- **Location:** `src/RequestManager.ts`, `src/WalletSDK.ts`
- **Description:** The SDK resolves wallet operations from `window` custom events (`onWalletSession`, `signMessageResponse`, etc.) using only loose shape checks (`typeof signature === "string"`), without origin/source/authenticity guarantees.
- **Impact:** Any script in the page context (XSS, malicious dependency, hostile widget) can forge success/reject events and force wallet flow outcomes.
- **Exploitation Scenario:**  
  Attacker injects:
  `window.dispatchEvent(new CustomEvent("signMessageResponse", { detail: { signature: "fake_sig" } }))`  
  before native wallet responds, causing Promise resolution with attacker-controlled data.

**Observed vulnerable pattern:**

```ts
window.addEventListener(eventName, listener);
// ...
if (!this.validateEventDetail(eventName, detail)) return;
resolve(detail as NativeEventPayloadMap[K]);
```

### Recommended Fix

1. Stop trusting DOM custom events for auth-critical responses.
2. Receive signing/session results via authenticated `postMessage` only.
3. Enforce: exact `origin`, `source`, `clientId`, and `requestId` match.
4. Optionally add wallet signature over response payload.

**Suggested implementation direction:**

```ts
// Request includes requestId + nonce
const requestId = crypto.randomUUID();
bridge.call("solana_signMessage", { requestId, nonce, encryptedPayload });

// Response must include exact requestId and pass bridge envelope guards
if (resp.requestId !== requestId) throw new SDKError(...);
```

---

## [VULN-002] Missing Request/Response Correlation (Event Name-Only Matching)

- **Severity:** 🔴 HIGH
- **Location:** `src/RequestManager.ts`
- **Description:** Pending waits are keyed by `NativeEventName` instead of per-request IDs. New waits can cancel/replace previous waits of same event type.
- **Impact:** Replay/race/confused-deputy risk across concurrent operations.
- **Exploitation Scenario:**  
  A stale or attacker-forged `signMessageResponse` can satisfy an unrelated in-flight `signMessage` call.

### Recommended Fix

- Use `Map<requestId, PendingSlot>` instead of event-name map.
- Include `requestId` in outbound payload and require same ID in response.
- Reject unmatched IDs silently; timeout unmatched requests.

---

## [VULN-003] Session Key Substitution / Fixation via Forged `onWalletSession`

- **Severity:** 🔴 HIGH
- **Location:** `src/WalletSDK.ts`, `src/crypto.ts`
- **Description:** `connect()` accepts `sessionId` from native event and uses it directly as RSA public key (`encryptHybridJson(payload, sessionId)`), with no authenticity proof.
- **Impact:** Attacker can inject their own RSA public key; encrypted payload confidentiality is lost (attacker decrypts contents).
- **Exploitation Scenario:**  
  Forge `onWalletSession` with attacker key and valid-shaped chain/account, then observe encrypted requests and decrypt offline.

### Recommended Fix

- Bind session establishment to authenticated bridge response.
- Wallet must attest session key with a signed challenge containing:
  - dApp origin
  - requestId + nonce
  - chainId
  - accountId
  - session public key fingerprint
- SDK verifies attestation before accepting session.

---

## [VULN-004] `walletOrigin` Auto-Detection is Attacker-Influenceable

- **Severity:** 🔴 HIGH
- **Location:** `src/Bridge.ts` (`detectWalletOrigin`)
- **Description:** Fallbacks to URL query param (`?walletOrigin=`) and `document.referrer`.
- **Impact:** Trust boundary can be redirected to attacker-controlled origin in hostile embed/phishing/open-redirect contexts.

### Recommended Fix

- Make `walletOrigin` mandatory in production mode.
- Enforce explicit allowlist (exact match, no wildcards).
- Disable query/referrer inference by default.

**Suggested hardened API contract:**

```ts
type WalletSDKConfig = {
  walletOrigin: string; // required
  allowedWalletOrigins?: readonly string[]; // optional strict list
  // ...
};
```

---

## [VULN-005] Incomplete CAIP Account/Chain Binding Validation

- **Severity:** 🟠 MEDIUM
- **Location:** `src/WalletSDK.ts`, `src/accountId.ts`
- **Description:** Chain format checks are permissive (`startsWith("solana:")` / `startsWith("eip155:")`), and account parsing is lax.
- **Impact:** Identity confusion / malformed account ingestion.

### Recommended Fix

- Add strict regex parser:
  - CAIP-2: `^([a-z0-9-]{3,8}):([a-zA-Z0-9-]{1,32})$`
  - CAIP-10: `^([a-z0-9-]{3,8}):([a-zA-Z0-9-]{1,32}):(.+)$`
- Ensure `accountId` namespace/reference strictly equals connected `chainId`.
- Enforce family-specific address validation:
  - EVM: 20-byte hex (+ optional checksum validation)
  - Solana: valid base58 public key length/parse

---

## [VULN-006] Session Persistence Default Increases XSS Blast Radius

- **Severity:** 🟠 MEDIUM
- **Location:** `src/WalletSDK.ts`, `src/sessionPersistence.ts`
- **Description:** `persistSession` defaults to true and stores session metadata in `sessionStorage`.
- **Impact:** Same-origin script/XSS can read/modify persisted session data.

### Recommended Fix

- Default `persistSession` to `false`.
- If enabled, store only opaque wallet-issued token (signed, short TTL), not key material.
- Add integrity field (HMAC/signature) checked before restore.

---

## [VULN-007] Sensitive Session Logging

- **Severity:** 🟠 MEDIUM
- **Location:** `src/WalletSDK.ts`, `src/logger.ts`
- **Description:** Debug logging includes full internal session JSON (includes `sessionId`, `accountId`).
- **Impact:** Secrets/identifiers may leak to logs, tooling, error collectors.

### Recommended Fix

- Redact sensitive fields before logging:
  - `sessionId` -> hashed/truncated
  - `accountId` -> partial mask
- Keep warning/error logs but avoid sensitive payload dumps.

---

## [VULN-008] Dependency Advisory Chain (`@solana/web3.js` Transitives)

- **Severity:** 🟠 MEDIUM
- **Location:** dependency graph (`package.json` / lockfile)
- **Description:** `npm audit` reports moderate advisories (notably `uuid` via `jayson` and `rpc-websockets` path).
- **Impact:** Supply-chain risk and compliance blocker for strict release policies.

### Recommended Fix

1. Track upstream `@solana/web3.js` releases and upgrade when patched.
2. Add CI gate:
   - `npm audit --audit-level=moderate`
3. Consider temporary overrides/resolutions if compatible.
4. Move `prettier` from runtime `dependencies` to `devDependencies`.

---

## [VULN-009] Disabled Integration/Security Test Suite

- **Severity:** 🟡 LOW
- **Location:** `tests/WalletSDK.test.ts`
- **Description:** Main suite is commented; only placeholder passes.
- **Impact:** Security regressions can ship undetected.

### Recommended Fix

- Re-enable suite and add adversarial tests for:
  - forged event injection
  - replay/correlation mismatch
  - origin enforcement
  - session fixation attempts
  - malformed CAIP identifiers

---

## [VULN-010] Build/Publish Pipeline Missing Security Gates

- **Severity:** 🟡 LOW
- **Location:** `package.json` scripts, release docs
- **Description:** `prepublishOnly` runs typecheck/build/test, but no explicit dependency/security/provenance gates.
- **Impact:** Known vulnerable lockfile may still publish.

### Recommended Fix

- Extend `prepublishOnly`:
  - `npm audit --audit-level=moderate`
  - optional SAST (`semgrep`, `eslint-plugin-security`)
  - package provenance/signature enforcement
- Add CI policy to block publish on critical/high vulnerabilities.

---

## 4. Architecture Security Assessment

### Is SDK safe for embedding in untrusted dApps?

**Current answer:** No.  
Unauthenticated DOM-event trust allows hostile in-page scripts to manipulate wallet outcomes.

### Can malicious dApp exploit wallet communication?

**Yes.**  
By dispatching forged custom events and exploiting lack of request correlation.

### Are transaction payloads tamper-proof?

**Partially.**  
Crypto primitives are strong (RSA-OAEP + AES-GCM), but session key authenticity is not guaranteed, so confidentiality/integrity assumptions fail under forged session establishment.

### Are signing flows secure and verifiable?

**Not fully.**  
No cryptographic verification of response origin/authenticity in the DOM event path.

---

## 5. Positive Controls (What Is Good)

- Strong typed `postMessage` envelope guard path in `Bridge` + `rpcGuards`.
- Chain allow-listing exists and is enforced.
- EVM RPC chain ID verification logic exists.
- Crypto choice is modern and appropriate for payload encryption.
- Teardown logic cancels pending listeners and handles session expiry cleanup.

---

## 6. Detailed Remediation Plan

## Phase 1 (Blocker, before publish)

1. Replace event-based response channel with authenticated bridge response channel.
2. Add per-request `requestId` + nonce + strict matching.
3. Require explicit `walletOrigin` and reject implicit inference.
4. Introduce strict CAIP parser + account/chain binding checks.

## Phase 2 (Hardening)

1. Default `persistSession` to false.
2. Redact logs.
3. Reinstate security-focused tests.
4. Add dependency and provenance gates in CI/publish.

## Phase 3 (Continuous Assurance)

1. Monthly dependency patch cadence.
2. Threat-model updates per protocol change.
3. Periodic external security review before major releases.

---

## 7. Suggested Code-Level Fix Patterns

### A) Correlation-safe pending map

```ts
type PendingById = Map<
  string,
  {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }
>;
```

### B) Strict CAIP validators

```ts
const CAIP2_RE = /^([a-z0-9-]{3,8}):([a-zA-Z0-9-]{1,32})$/;
const CAIP10_RE = /^([a-z0-9-]{3,8}):([a-zA-Z0-9-]{1,32}):(.+)$/;
```

### C) Mandatory trusted origin

```ts
if (!config.walletOrigin?.trim()) {
  throw new SDKError(SDKErrorCode.INVALID_CONFIG, "walletOrigin is required");
}
```

### D) Redacted debug log

```ts
logger.i("internal session set", {
  chainId: s.chainId,
  address: s.address,
  sessionId: `${s.sessionId.slice(0, 8)}...`,
});
```

---

## 8. Dependency Security Consent

Reviewed high-impact direct runtime deps:

- `@solana/web3.js`
- `bs58`
- `tweetnacl` (peer/dev usage)

`npm audit` currently reports moderate advisories in transitive graph and must be re-evaluated after dependency updates/overrides.

---

## 9. Final Verdict

**Ready for Production:** ❌ **NO**

This SDK should **not** be published as-is for real-funds hostile environments.  
Address P0 findings (VULN-001..004) first, then perform a focused re-audit with adversarial tests.

---

## 10. Attestation

I hereby certify that the code has been reviewed to the best of my ability for the vulnerabilities listed above under strict hostile-environment assumptions.

**Signed:** Codex 5.3 (AI Security Review)  
**Role:** Senior Security Researcher & DevSecOps (simulated profile)
