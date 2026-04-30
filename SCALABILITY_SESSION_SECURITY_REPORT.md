# Outlaw WebView Bridge SDK

## Session Handling, Storage, and Load Readiness Report

Date: 2026-04-29

This report evaluates how the SDK handles user/session data, how safely it stores state, and how reliable it is when many users connect at the same time.

---

## Executive Readiness Score

- Overall current readiness: **84%**
- Session isolation correctness: **92%**
- Data security in transit: **90%**
- Storage security at rest (browser side): **80%**
- High-concurrency resilience (same instance/tab): **85%**
- Observability and production diagnostics: **80%**

These percentages are **engineering confidence estimates** based on code behavior and current tests, not benchmark-lab measured SLO numbers.

---

## What the SDK Handles Properly

- Correlated request handling is strong:
  - Responses must match `requestId` and `clientId`.
  - `sessionId` is also validated when present.
  - Mismatched/forged responses are rejected or timeout safely.
- Session scope is per SDK instance and per browser context:
  - Each instance generates a unique `clientId`.
  - Each request uses unique IDs.
  - No shared global session object across users/devices.
- Encryption model is solid:
  - Hybrid `RSA-OAEP + AES-256-GCM` per request.
  - Sensitive payloads are encrypted before wallet methods are called.
- Session lifecycle is controlled:
  - TTL enforced with expiry teardown.
  - `disconnect()` clears internal state, pending waits, and persisted snapshot.
- Config guardrails exist:
  - Chain allow-list enforced.
  - `walletOrigin` validation enforced (HTTPS requirement).

---

## Data Storage Model (How Individual Sessions Are Stored)

- In-memory active session (runtime):
  - `sessionId`, `chainId`, `accountId`, `address`, `expiresAt`, `rpcUrl`, `family`.
- Optional persisted snapshot (`sessionStorage`) when `persistSession: true`:
  - key includes stable fingerprint from `dapp.url + allowed chains`.
  - stores a minimal session payload for reload recovery.
- Session restoration safety:
  - schema/version checks.
  - required field checks.
  - expiry check and auto-cleanup.
  - malformed payload ignored.

Conclusion: per-user and per-tab separation is good; each user gets isolated browser storage/runtime.

---

## Load Behavior (Many Users Connecting at Same Time)

### Across many users/devices

- Expected behavior: **good isolation**.
- Why: each client runs independently in its own browser process/tab context.
- Risk of cross-user data mixing: **very low** under normal browser isolation assumptions.

### Inside one tab / one SDK instance with concurrent connect calls

With the in-flight `connect()` lock in place, concurrent calls on the same SDK instance are serialized and de-duped per `chainId`.

---

## Areas to Improve (Priority Order)

1. Connection in-flight lock or queue (**Completed**)
   - Prevent parallel `connect()` races per SDK instance.
   - De-dupe concurrent `connect()` calls per `chainId`.

2. Harden persisted session exposure (**Completed/Partial**)
   - `strict` mode now defaults to `persistSession: false`.
   - Added integrity checksum for `sessionStorage` snapshots (detects corruption; same-origin XSS can still read/modify storage).

3. Improve production observability (**Completed**)
   - Added `metrics: true` telemetry flag that logs lightweight events via `console.log`:
     - `connect_latency`
     - `session_restore`
     - `timeout`
     - `rejection`

4. Add deterministic concurrency tests (**Completed**)
   - Added tests for de-duped concurrent `connect()` and overlapping `signMessage()` flows.

5. Strengthen strict transport path rollout (**Pending**)
   - Native Android bridge currently dispatches legacy DOM events for critical flows.
   - Full `securityMode: "strict"` requires native + JS contract updates to deliver correlated `OUTLAW_BRIDGE_RESPONSE` for those methods.

---

## Suggested Target Scores After Improvements

- Overall readiness: **88% -> 94%**
- High-concurrency resilience: **85% -> 92%**
- Storage security at rest: **80% -> 88%**
- Observability: **80% -> 90%**

---

## How to Test and Validate the Percentages

Run these test layers and use measured pass/failure and latency to replace estimates:

- Unit/integration:
  - forged correlation mismatch tests
  - malformed storage restore tests
  - TTL expiry and disconnect cleanup tests
- Concurrency stress (same instance):
  - N parallel `connect()` calls with controlled event order
  - parallel sign requests with mixed valid/invalid responses
- Multi-page synthetic load:
  - 100/300/500 concurrent browser sessions
  - track success rate, p95 latency, timeout %, reject %
- Security checks:
  - wrong origin/wrong source message rejection
  - no persistence when `persistSession: false`

Recommended acceptance baseline:

- > = 99.5% connect success under target load
- <= 0.3% timeout at p95 normal latency conditions
- 0 accepted forged responses
- 0 stale pending listeners after test completion

---

## Final Assessment

The SDK is already strong in session correlation, isolation, and encrypted payload transport. The biggest practical gaps are concurrency control inside a single SDK instance and security posture of optional persisted session snapshots. With the listed improvements, the SDK can move from good production readiness to high-confidence enterprise-grade readiness.
