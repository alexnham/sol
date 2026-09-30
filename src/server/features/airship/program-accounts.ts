import { rpcCall } from "../../infrastructure/rpc";

const PROGRAM_ACCOUNT_PAGE_SIZE = 1_000;

export interface JsonParsedProgramAccount {
  pubkey: string;
  account: {
    lamports: number | bigint;
    data: unknown;
  };
}

interface ProgramAccountsV2Page {
  accounts: JsonParsedProgramAccount[];
  paginationKey: string | null;
}

export async function getTokenProgramAccountsByMint(
  rpcUrl: string,
  tokenProgramAddress: string,
  mint: string,
  legacyFallback?: () => Promise<readonly JsonParsedProgramAccount[]>,
): Promise<JsonParsedProgramAccount[]> {
  const accounts: JsonParsedProgramAccount[] = [];
  const seenPaginationKeys = new Set<string>();
  let paginationKey: string | null = null;

  try {
    do {
      const page: ProgramAccountsV2Page = await rpcCall<ProgramAccountsV2Page>(rpcUrl, "getProgramAccountsV2", [
        tokenProgramAddress,
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          filters: [{ memcmp: { offset: 0, bytes: mint, encoding: "base58" } }],
          limit: PROGRAM_ACCOUNT_PAGE_SIZE,
          ...(paginationKey ? { paginationKey } : {}),
        },
      ]);

      if (!Array.isArray(page.accounts)) {
        throw new Error("RPC getProgramAccountsV2 returned malformed accounts");
      }

      accounts.push(...page.accounts);

      if (page.paginationKey !== null && typeof page.paginationKey !== "string") {
        throw new Error("RPC getProgramAccountsV2 returned a malformed pagination key");
      }

      paginationKey = page.paginationKey;
      if (paginationKey) {
        if (seenPaginationKeys.has(paginationKey)) {
          throw new Error("RPC getProgramAccountsV2 repeated a pagination key");
        }
        seenPaginationKeys.add(paginationKey);
      }
    } while (paginationKey);

    return accounts;
  } catch (reason) {
    if (!legacyFallback || !isUnsupportedRpcMethod(reason)) throw reason;
    return [...await legacyFallback()];
  }
}

function isUnsupportedRpcMethod(reason: unknown): boolean {
  return reason instanceof Error && /method not found|does not exist|not supported/i.test(reason.message);
}
