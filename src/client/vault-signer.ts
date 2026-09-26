import {
  address,
  getBase64EncodedWireTransaction,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import type { SignerProvider } from "../shared/contracts";
import { requestVaultSignature } from "./api";

export function createVaultSignerProvider(preparationId: string): SignerProvider {
  return {
    id: "local-key-vault",
    async getSigner(signerAddress): Promise<TransactionPartialSigner> {
      return {
        address: address(String(signerAddress)),
        async signTransactions(transactions) {
          return Promise.all(transactions.map(async (transaction) => {
            const result = await requestVaultSignature(
              preparationId,
              String(signerAddress),
              getBase64EncodedWireTransaction(transaction),
            );
            return {
              [signerAddress]: decodeBase64(result.signature) as SignatureBytes,
            };
          }));
        },
      };
    },
  };
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
