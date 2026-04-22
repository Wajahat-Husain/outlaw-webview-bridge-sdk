import type {
  EthSendTransactionParams,
  EthSendTransactionResult,
  PersonalSignParams,
  PersonalSignResult,
  SolanaSignAndSendTransactionParams,
  SolanaSignAndSendTransactionResult,
  SolanaSignMessageParams,
  SolanaSignMessageResult,
  SolanaSignTransactionParams,
  SolanaSignTransactionResult,
  WalletCreateSessionParams,
  WalletCreateSessionResult,
} from "./bridgeTypes.js";
import type { HybridEncryptionResult } from "./crypto.js";

type RpcDef<P = unknown, R = unknown> = {
  params: P;
  result: R;
};

/**
 * Typed bridge RPC registry.
 * Add/remove methods here to keep WalletBridge transport-only and strongly typed.
 */
export interface WalletRpcMap {
  wallet_ping: RpcDef<undefined, unknown>;
  /** Params are optional when `WalletBridge` is constructed with `bridgeContext`. */
  wallet_createSession: RpcDef<
    WalletCreateSessionParams | undefined,
    WalletCreateSessionResult
  >;
  wallet_disconnect: RpcDef<{ sessionId?: string }, { ok: boolean } | null>;
}

export interface EvmRpcMap {
  eth_sendTransaction: RpcDef<
    EthSendTransactionParams,
    EthSendTransactionResult
  >;
  personal_sign: RpcDef<PersonalSignParams, PersonalSignResult>;
  eth_requestAccounts: RpcDef<undefined, string[]>;
  eth_chainId: RpcDef<undefined, string>;
}

export interface SolanaRpcMap {
  solana_signTransaction: RpcDef<
    SolanaSignTransactionParams | { encryptedPayload: HybridEncryptionResult },
    SolanaSignTransactionResult
  >;
  solana_signMessage: RpcDef<
    SolanaSignMessageParams | { encryptedPayload: HybridEncryptionResult },
    SolanaSignMessageResult
  >;
  solana_signAndSendTransaction: RpcDef<
    | SolanaSignAndSendTransactionParams
    | { encryptedPayload: HybridEncryptionResult },
    SolanaSignAndSendTransactionResult
  >;
  solana_connect: RpcDef<undefined, { publicKey: string }>;
}

export type BridgeRpcMap = WalletRpcMap & EvmRpcMap & SolanaRpcMap;

export type RpcMethod = keyof BridgeRpcMap;
export type RpcParams<M extends RpcMethod> = BridgeRpcMap[M]["params"];
export type RpcResult<M extends RpcMethod> = BridgeRpcMap[M]["result"];
export type RpcArgs<M extends RpcMethod> =
  RpcParams<M> extends undefined
    ? []
    : [RpcParams<M>] extends [undefined]
      ? []
      : undefined extends RpcParams<M>
        ? [params?: Exclude<RpcParams<M>, undefined>]
        : [params: RpcParams<M>];
