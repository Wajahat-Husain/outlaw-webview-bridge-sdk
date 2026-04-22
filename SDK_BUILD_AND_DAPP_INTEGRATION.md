# SDK Build, Publish, and Local Usage

Minimal guide to:

- Build the SDK
- Publish a release
- Use the SDK locally in a dApp

---

## Prerequisites

- Node.js `>=18`
- npm `>=9`

```bash
npm install
```

---

## Build

```bash
npm run build
```

Build output:

- `dist/esm`
- `dist/cjs`
- `dist/types`

Useful checks:

```bash
npm run typecheck
npm test
```

During local SDK development:

```bash
npm run build:watch
```

---

## Publish

Validate first:

```bash
npm run typecheck
npm run build
npm test
```

Version bump:

```bash
npm version patch
# or: npm version minor
# or: npm version major
```

Publish:

```bash
npm publish
```

---

## Use SDK in a dApp

From npm registry:

```bash
npm install @outlaw/webview-bridge-sdk tweetnacl
```

Local path install:

```bash
npm install "D:/GITHUB REPOS/outlaw-webview-bridge-sdk"
```

`npm link` workflow:

```bash
# in SDK repo
npm link

# in dApp repo
npm link @outlaw/webview-bridge-sdk
```

When using local install or link, keep SDK rebuilt (`npm run build` or `npm run build:watch`).

---

## Verify dApp uses expected SDK version

```bash
npm ls @outlaw/webview-bridge-sdk
```

Smoke test in dApp:

- `connect(chainId)` works
- `signMessage()` works
- `signAndSendTransaction()` works
