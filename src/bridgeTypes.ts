export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccess<R>
  | JsonRpcErrorResponse;

export interface BridgeEnvelope {
  type: "OUTLAW_BRIDGE_REQUEST" | "OUTLAW_BRIDGE_RESPONSE";
  clientId: string;
  /**
   * When the SDK has an active session, requests include the wallet RSA `sessionId`
   * and responses SHOULD echo it so only the session-bound postMessage can satisfy
   * the pending call (in addition to origin, source, and clientId checks).
   */
  sessionId?: string;
  payload: JsonRpcRequest | JsonRpcResponse;
}

// -------------------- Session & Identity --------------------

export interface WalletEvmIdentity {
  chainId: string;
  chainNumeric: bigint;
  address: string;
  accountId: string;
}

export interface WalletSolanaIdentity {
  chainId: string;
  cluster: string;
  address: string;
  accountId: string;
}

export interface WalletSession {
  id: string;
  sessionId: string;
  chainId: string;
  accountId: string;
}

export interface WalletCreateSessionParams {
  dapp: {
    name: string;
    description?: string;
    url: string;
    icon?: string;
  };
  requested: {
    evmChainId?: string;
    solanaChainId?: string;
  };
}

/** Merged into every bridge JSON-RPC `params` when `WalletBridge` is constructed with `bridgeContext`. */
export type BridgePostContext = Pick<
  WalletCreateSessionParams,
  "dapp" | "requested"
>;

export interface WalletCreateSessionResult {
  sessionId: string;
  /**
   * One-time token for session restoration. This token can be stored in sessionStorage
   * instead of the live sessionId to mitigate XSS extraction risks. The native wallet
   * validates this token during restore and issues a fresh sessionId.
   */
  restoreToken: string;
  evm: WalletEvmIdentity | null;
  solana: WalletSolanaIdentity | null;
  expiresAt: number;
}

export interface WalletRestoreSessionParams {
  restoreToken: string;
  clientId: string;
}

export interface WalletRestoreSessionResult {
  sessionId: string;
  expiresAt: number;
}

// -------------------- Method-Specific Params/Results --------------------

export interface EthSendTransactionParams {
  encodedTransaction: string;
  chainId?: string;
}

export interface EthSendTransactionResult {
  hash: string;
}

export interface PersonalSignParams {
  message: string;
  address?: string;
}

export interface PersonalSignResult {
  signature: string;
}

export interface SolanaSignTransactionParams {
  encodedTransaction: string;
  options?: {
    encoding?: "base64" | "base58";
  };
}

export interface SolanaSignTransactionResult {
  signedTransaction: string;
  signature: string;
}

export interface SolanaSignMessageParams {
  message: Uint8Array | string;
  encoding?: "utf8" | "base64";
}

export interface SolanaSignMessageResult {
  signature: string;
  publicKey: string;
}

export interface SolanaSignAndSendTransactionParams {
  encodedTransaction: string;
  options?: {
    encoding?: "base64";
    skipPreflight?: boolean;
    preflightCommitment?: "processed" | "confirmed" | "finalized";
  };
}

export interface SolanaSignAndSendTransactionResult {
  signature: string;
}

// -------------------- Error Codes --------------------

export enum BridgeErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  SESSION_EXPIRED = -32001,
  UNAUTHORIZED = -32002,
  USER_REJECTED = -32003,
  NETWORK_ERROR = -32004,
  INVALID_TRANSACTION = -32005,
}
