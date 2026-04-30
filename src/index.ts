/**
 * @outlaw/webview-bridge-sdk
 *
 * Promise-based WebView wallet SDK for Outlaw mobile dApps.
 * Supports Solana (and EVM extension path).
 *
 * Usage:
 *   import { WalletSDK } from "@outlaw/webview-bridge-sdk"
 *
 *   const sdk = new WalletSDK({ dapp: { name: "My dApp", url: "https://..." }, chains: ["solana:devnet"] })
 *   const session = await sdk.connect("solana:devnet")
 *   const { signature } = await sdk.signMessage({ message: "Hello!" })
 *   const { signature } = await sdk.signAndSendTransaction({ encodedTransaction: base64Tx })
 *
 * @version 2.0.0
 */

// ── Primary entry point ───────────────────────────────────────────────────────
export { WalletSDK } from "./WalletSDK.js";

// ── Types (all public-facing) ─────────────────────────────────────────────────
export type {
  AccountInfo,
  Session,
  WalletResponse,
  SolanaSignMessagePayload,
  SolanaTransactionPayload,
  Eip712TypedDataV4,
  EVMSignMessagePayload,
  EVMTransactionPayload,
  SignAndSendTransactionPayload,
  WalletSDKConfig,
  DAppInfo,
  EncryptedPayload,
  NativeEventPayloadMap,
  NativeEventName,
  WaitContext,
  PendingSlot,
} from "./types.js";

// ── Errors ────────────────────────────────────────────────────────────────────
export { SDKError, SDKErrorCode, isSdkError } from "./errors.js";

// ── Lower-level modules (for advanced / custom integrations) ──────────────────
export {
  WalletBridge,
  Bridge,
  BridgeError,
  detectWalletOrigin,
} from "./Bridge.js";
export type { WalletBridgeOptions, BridgeConfig } from "./Bridge.js";
export { RequestManager } from "./RequestManager.js";

// ── Bridge types ──────────────────────────────────────────────────────────────
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcErrorResponse,
  JsonRpcErrorObject,
  BridgeEnvelope,
  BridgePostContext,
  WalletCreateSessionParams,
  WalletCreateSessionResult,
  WalletEvmIdentity,
  WalletSolanaIdentity,
  SolanaSignMessageParams,
  SolanaSignMessageResult,
  SolanaSignTransactionParams,
  SolanaSignTransactionResult,
  SolanaSignAndSendTransactionParams,
  SolanaSignAndSendTransactionResult,
  EthSendTransactionParams,
  EthSendTransactionResult,
  PersonalSignParams,
  PersonalSignResult,
  BridgeErrorCode,
} from "./bridgeTypes.js";
export { BridgeErrorCode as BridgeErrorCodes } from "./bridgeTypes.js";

// ── Bridge RPC map ────────────────────────────────────────────────────────────
export type {
  BridgeRpcMap,
  RpcMethod,
  RpcParams,
  RpcResult,
  RpcArgs,
} from "./bridgeRpc.js";

// ── RPC guards ────────────────────────────────────────────────────────────────
export { isJsonRpcResponse, isBridgeResponseEnvelope } from "./rpcGuards.js";

// ── Crypto utilities (for custom payload handling) ────────────────────────────
export {
  encryptHybridJson,
  encryptPayload,
  toBase64,
  fromBase64,
  randomUUID,
} from "./crypto.js";
export type { HybridEncryptionResult } from "./crypto.js";

// ── Chain allow-list (defaults + overrides) ────────────────────────────────
export {
  resolveChain,
  isKnownDefaultChain,
  buildWalletCreateSessionRequested,
} from "./chainRegistry.js";
export type { ChainFamily, ResolvedChain } from "./chainRegistry.js";
