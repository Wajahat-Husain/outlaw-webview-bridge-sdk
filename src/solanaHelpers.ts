import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import { bytesToBase64 } from "./encoding.js";

export type DecodedSolanaTransfer = {
  fromPubkey: string;
  toPubkey: string;
  lamports: bigint;
};

export type SolanaInstructionPayload = {
  programId: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
};

export type SolanaSignTransactionPayload = {
  feePayer: string;
  recentBlockhash: string;
  instructions: SolanaInstructionPayload[];
  partialSignatures: string[];
  transaction: string;
};

export function toSolanaSignTransactionPayload(
  tx: Transaction,
): SolanaSignTransactionPayload {
  if (!tx.feePayer) throw new Error("Solana tx missing feePayer");
  if (!tx.recentBlockhash) throw new Error("Solana tx missing recentBlockhash");

  const transaction = bytesToBase64(
    tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );

  const instructions = tx.instructions.map((ix) => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: bs58.encode(ix.data),
  }));

  return {
    feePayer: tx.feePayer.toBase58(),
    recentBlockhash: tx.recentBlockhash,
    instructions,
    partialSignatures: tx.signatures
      .filter((sig) => sig.signature !== null)
      .map((sig) => bs58.encode(sig.signature as Uint8Array)),
    transaction,
  };
}
