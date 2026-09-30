import { randomUUID } from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  getCloseAccountInstruction,
} from "@solana-program/token";

import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda as findToken2022AssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction as getCreateToken2022AssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction as getTransferCheckedToken2022Instruction,
  getCloseAccountInstruction as getCloseToken2022AccountInstruction,
} from "@solana-program/token-2022";

import {
  sendRpc,
  waitForConfirmation,
} from "@solana-workbench/delivery-sdk";

import type {
  AirshipCompressedBalanceReport,
  AirshipDecompressionResult,
  AirshipDropJob,
  AirshipToken,
  CreateAirshipDropRequest,
  DecompressAirshipTokensRequest,
  CreateTokenCollectionRequest,
  PreviewTokenCollectionRequest,
  TokenCollectionJob,
  TokenCollectionPreview,
  TokenCollectionPreviewSource,
} from "../../../shared/airship";

import type { Network } from "../../../shared/contracts";

import { rpcCall } from "../../infrastructure/rpc";
import { runWithConcurrency } from "./concurrency";
import { getTokenProgramAccountsByMint } from "./program-accounts";

export { getTokenProgramAccountsByMint } from "./program-accounts";

import {
  getAirshipCompressInstruction,
  getAirshipCreatePoolInstruction,
  getAirshipDecompressInstruction,
  getAirshipStateTree,
  getAirshipTokenPoolAddress,
} from "../../infrastructure/light-kit-adapter";

const MAX_RECIPIENTS = 200_000;

const MAX_ADDRESSES_PER_TRANSACTION = 15;
const MAX_ADDRESSES_PER_INSTRUCTION = 5;

const MAX_STANDARD_RECIPIENTS_PER_TRANSACTION = 10;
const MAX_COLLECTION_SOURCES_PER_TRANSACTION = 10;
const AIRDROP_BATCH_CONCURRENCY = 4;

const COMPUTE_UNIT_LIMIT = 550_000;
const DECOMPRESS_COMPUTE_UNIT_LIMIT = 1_000_000;

/**
 * Tx v1 uses a TOTAL priority fee in lamports.
 *
 * This is NOT the old v0 microLamports-per-CU value.
 */
const PRIORITY_FEE_LAMPORTS = 5_000n;

/**
 * v1 does not inherit the legacy/v0 64 MiB default.
 * If this is omitted, the v1 loaded-account-data limit defaults to zero.
 *
 * 64 MiB:
 * 64 * 1024 * 1024 = 67,108,864 bytes
 */
const LOADED_ACCOUNTS_DATA_SIZE_LIMIT =
  64 * 1024 * 1024;

const SUPPORTED_TOKEN_2022_EXTENSIONS = new Set([
  "metadata_pointer",
  "metadata",
  "interest_bearing_config",
  "group_pointer",
  "group_member_pointer",
  "token_group",
  "token_group_member",
]);

interface DasAsset {
  id: string;

  interface?: string;

  content?: {
    metadata?: {
      name?: string;
    };
  };

  token_info?: {
    token_program?: string;
    associated_token_address?: string;
    symbol?: string;
    decimals?: number;
  };

  mint_extensions?: Record<string, unknown>;
}

interface DasAssetsByOwnerResponse {
  items: DasAsset[];
}

interface CompressedTokenAccount {
  tokenData: {
    mint: string;
    owner: string;
    amount: number | string;
  };
}

interface CompressedTokenAccountsResponse {
  value: {
    items: CompressedTokenAccount[];
    cursor: string | null;
  };
}

interface LatestBlockhash {
  value: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

interface JsonRpcResponse<T> {
  result?: T;

  error?: {
    message?: string;
  };
}

const jobs = new Map<string, AirshipDropJob>();
const collectionJobs = new Map<string, TokenCollectionJob>();
const activeSenders = new Set<string>();

export async function listAirshipTokens(
  rpcUrl: string,
  owner: string,
): Promise<AirshipToken[]> {
  const ownerAddress = address(owner);

  const das =
    await heliusDasCall<DasAssetsByOwnerResponse>(
      rpcUrl,
      "getAssetsByOwner",
      {
        ownerAddress,
        page: 1,
        limit: 1_000,

        sortBy: {
          sortBy: "created",
          sortDirection: "asc",
        },

        options: {
          showFungible: true,
          showZeroBalance: false,
          showNativeBalance: false,
        },
      },
    );

  const candidates = das.items.filter(
    (item) =>
      item.interface === "FungibleToken" &&
      item.token_info?.associated_token_address,
  );

  const rpc = createSolanaRpc(rpcUrl);

  return Promise.all(
    candidates.flatMap((item) => {
      const tokenProgram =
        item.token_info?.token_program;

      if (
        tokenProgram !== TOKEN_PROGRAM_ADDRESS &&
        tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS
      ) {
        return [];
      }

      const mint = address(item.id);

      const tokenAccount = address(
        item.token_info!
          .associated_token_address!,
      );

      return [
        rpc
          .getTokenAccountBalance(
            tokenAccount,
            {
              commitment: "confirmed",
            },
          )
          .send()
          .then((balance) => ({
            mint,

            name:
              item.content?.metadata?.name?.trim() ||
              item.token_info?.symbol?.trim() ||
              "Unnamed token",

            symbol:
              item.token_info?.symbol?.trim() ||
              shortAddress(mint),

            decimals:
              item.token_info?.decimals ??
              balance.value.decimals,

            balanceBaseUnits:
              balance.value.amount,

            tokenProgram:
              tokenProgram ===
              TOKEN_PROGRAM_ADDRESS
                ? ("classic" as const)
                : ("token2022" as const),

            supported:
              tokenProgram ===
                TOKEN_PROGRAM_ADDRESS ||
              Object.keys(
                item.mint_extensions ?? {},
              ).every((key) =>
                SUPPORTED_TOKEN_2022_EXTENSIONS.has(
                  key,
                ),
              ),
          })),
      ];
    }),
  );
}

export async function getAirshipCompressedBalances(
  rpcUrl: string,
  owner: string,
): Promise<AirshipCompressedBalanceReport> {
  let ownerAddress: Address;

  try {
    ownerAddress = address(owner.trim());
  } catch {
    throw new Error(
      "Enter a valid recipient address",
    );
  }

  const totals = new Map<
    string,
    {
      balance: bigint;
      accountCount: number;
    }
  >();

  let cursor: string | undefined;

  do {
    const page =
      await heliusDasCall<CompressedTokenAccountsResponse>(
        rpcUrl,
        "getCompressedTokenAccountsByOwner",
        {
          owner: ownerAddress,
          cursor,
        },
      );

    for (const account of page.value.items) {
      const current =
        totals.get(account.tokenData.mint) ?? {
          balance: 0n,
          accountCount: 0,
        };

      current.balance += BigInt(
        String(account.tokenData.amount),
      );

      current.accountCount += 1;

      totals.set(
        account.tokenData.mint,
        current,
      );
    }

    cursor =
      page.value.cursor ?? undefined;
  } while (cursor);

  const rpc =
    createSolanaRpc(rpcUrl);

  const balances = await Promise.all(
    [...totals.entries()].map(
      async ([mint, total]) => {
        const supply = await rpc
          .getTokenSupply(address(mint), {
            commitment: "confirmed",
          })
          .send();

        return {
          mint,

          decimals:
            supply.value.decimals,

          balanceBaseUnits:
            total.balance.toString(),

          accountCount:
            total.accountCount,
        };
      },
    ),
  );

  balances.sort((left, right) =>
    left.mint.localeCompare(right.mint),
  );

  return {
    owner: ownerAddress,

    balances,

    accountCount: balances.reduce(
      (sum, balance) =>
        sum + balance.accountCount,
      0,
    ),
  };
}

export async function previewTokenCollection(
  rpcUrl: string,
  request: PreviewTokenCollectionRequest,
  managedOwnerAddresses: string[],
): Promise<TokenCollectionPreview> {
  const destination = address(request.destination.trim());
  const mint = address(request.mint.trim());
  const requestedSources = request.sources?.map((source) => ({ ...source, owner: address(source.owner.trim()) }));
  if (requestedSources && new Set(requestedSources.map((source) => source.owner)).size !== requestedSources.length) {
    throw new Error("Source wallets must be unique");
  }
  if (requestedSources?.some((source) => source.owner === destination)) throw new Error("The destination wallet cannot also be a source");
  const requestedByOwner = new Map(requestedSources?.map((source) => [source.owner, source]));
  const selectAll = request.sources === undefined;
  const managedOwners = new Set(managedOwnerAddresses.map((owner) => String(address(owner))));

  const rpc = createSolanaRpc(rpcUrl);
  const [mintInfo, supply] = await Promise.all([
    rpc.getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" }).send(),
    rpc.getTokenSupply(mint, { commitment: "confirmed" }).send(),
  ]);
  if (!mintInfo.value) throw new Error("Token mint was not found");
  const mintOwner = String(mintInfo.value.owner);
  const tokenProgram = mintOwner === TOKEN_PROGRAM_ADDRESS ? "classic" as const
    : mintOwner === TOKEN_2022_PROGRAM_ADDRESS ? "token2022" as const : null;
  if (!tokenProgram) throw new Error("Mint is not owned by SPL Token or Token-2022");
  const decimals = supply.value.decimals;
  const tokenProgramAddress = tokenProgram === "classic" ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
  const [destinationTokenAccount] = tokenProgram === "classic"
    ? await findAssociatedTokenPda({ owner: destination, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    : await findToken2022AssociatedTokenPda({ owner: destination, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const programAccounts = await getTokenProgramAccountsByMint(
    rpcUrl,
    String(tokenProgramAddress),
    String(mint),
    async () => rpc.getProgramAccounts(tokenProgramAddress, {
      commitment: "confirmed",
      encoding: "jsonParsed",
      filters: [{ memcmp: { offset: 0n, bytes: mint as never, encoding: "base58" } }],
    }).send(),
  );

  const discovered = await Promise.all(programAccounts.map(async (entry) => {
    const parsed = entry.account.data as unknown as { parsed?: { info?: Record<string, unknown> } };
    const info = parsed.parsed?.info;
    if (!info || String(info.mint) !== mint) return null;
    const owner = address(String(info.owner));
    const amountValue = (info.tokenAmount as { amount?: unknown } | undefined)?.amount;
    if (!managedOwners.has(owner) || owner === destination || typeof amountValue !== "string") return null;
    const tokenAccount = address(String(entry.pubkey));
    const [canonicalAta] = tokenProgram === "classic"
      ? await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
      : await findToken2022AssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    if (tokenAccount !== canonicalAta) return excludedCollectionSource(owner, tokenAccount, "Only the canonical associated token account can be collected");
    const input = requestedByOwner.get(owner);
    const selected = selectAll || input !== undefined;
    const balanceBaseUnits = BigInt(amountValue);
    if (String(info.state).toLowerCase() === "frozen") return { ...excludedCollectionSource(owner, tokenAccount, "Token account is frozen"), selected };
    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = input?.amount === undefined
        ? balanceBaseUnits
        : balanceBaseUnits === 0n && /^0+(?:\.0*)?$/.test(input.amount.trim())
          ? 0n
          : parseTokenAmount(input.amount, decimals);
    }
    catch (reason) { return { ...excludedCollectionSource(owner, tokenAccount, reason instanceof Error ? reason.message : "Invalid amount"), selected }; }
    if (amountBaseUnits > balanceBaseUnits) return { ...excludedCollectionSource(owner, tokenAccount, "Requested amount exceeds the live balance"), selected };
    const willClose = amountBaseUnits === balanceBaseUnits;
    const closeAuthority = typeof info.closeAuthority === "string" ? info.closeAuthority : owner;
    if (willClose && closeAuthority !== owner) return { ...excludedCollectionSource(owner, tokenAccount, "Source wallet is not the close authority"), selected };
    return {
      owner, tokenAccount, balanceBaseUnits: balanceBaseUnits.toString(), balance: formatTokenUnits(balanceBaseUnits, decimals),
      amountBaseUnits: amountBaseUnits.toString(), amount: formatTokenUnits(amountBaseUnits, decimals),
      rentLamports: String(entry.account.lamports), selected, willClose, eligible: true,
    };
  }));
  const sources = discovered.filter((source): source is TokenCollectionPreviewSource => source !== null)
    .sort((left, right) => left.owner.localeCompare(right.owner));
  const eligible = sources.filter((source) => source.eligible && source.selected);
  const closable = eligible.filter((source) => source.willClose);
  const estimatedTransactions = Math.ceil(eligible.length / MAX_COLLECTION_SOURCES_PER_TRANSACTION);
  const estimatedSignatures = eligible.length + estimatedTransactions;
  return {
    network: request.network, destination, destinationTokenAccount, mint, decimals, tokenProgram, sources,
    eligibleSourceCount: eligible.length, closeableAccountCount: closable.length,
    totalAmountBaseUnits: eligible.reduce((sum, source) => sum + BigInt(source.amountBaseUnits), 0n).toString(),
    reclaimedRentLamports: closable.reduce((sum, source) => sum + BigInt(source.rentLamports), 0n).toString(),
    estimatedTransactions,
    estimatedFeeLamports: (BigInt(estimatedSignatures) * 5_000n + BigInt(estimatedTransactions) * PRIORITY_FEE_LAMPORTS).toString(),
  };
}

export async function createTokenCollection(
  rpcUrl: string,
  request: CreateTokenCollectionRequest,
  getSigner: (owner: string) => Promise<KeyPairSigner>,
  managedOwnerAddresses: string[],
): Promise<TokenCollectionJob> {
  if (request.network === "mainnet" && request.mainnetConfirmed !== true) throw new Error("Mainnet token collection requires explicit confirmation");
  if (request.sources.length === 0) throw new Error("Select at least one source wallet");
  const preview = await previewTokenCollection(rpcUrl, request, managedOwnerAddresses);
  const eligible = preview.sources.filter((source) => source.eligible && source.selected);
  if (eligible.length === 0) throw new Error("No eligible token accounts to collect");
  const locked = [preview.destination, ...eligible.map((source) => source.owner)];
  if (locked.some((owner) => activeSenders.has(owner))) throw new Error("A selected wallet already has an action in progress");
  const signerEntries = await Promise.all([...new Set(locked)].map(async (owner) => [owner, await getSigner(owner)] as const));
  const signers = new Map(signerEntries);
  locked.forEach((owner) => activeSenders.add(owner));
  const now = new Date().toISOString();
  const job: TokenCollectionJob = {
    id: randomUUID(), network: request.network, destination: preview.destination,
    destinationTokenAccount: preview.destinationTokenAccount, mint: preview.mint, decimals: preview.decimals,
    tokenProgram: preview.tokenProgram, sourceCount: eligible.length,
    excludedSources: preview.sources.filter((source) => !source.eligible), totalAmountBaseUnits: preview.totalAmountBaseUnits,
    totalTransactions: preview.estimatedTransactions, sentTransactions: 0, confirmedTransactions: 0,
    closedAccounts: 0, reclaimedRentLamports: "0", state: "queued", signatures: [], createdAt: now, updatedAt: now,
  };
  collectionJobs.set(job.id, job);
  void runTokenCollection(rpcUrl, job, eligible, signers)
    .catch((reason: unknown) => updateCollectionJob(job.id, { state: "failed", error: reason instanceof Error ? reason.message : "Token collection failed" }))
    .finally(() => locked.forEach((owner) => activeSenders.delete(owner)));
  return job;
}

export function getTokenCollection(id: string): TokenCollectionJob {
  const job = collectionJobs.get(id);
  if (!job) throw new Error("Token collection not found or server restarted");
  return job;
}

export async function createAirshipDrop(
  rpcUrl: string,
  request: CreateAirshipDropRequest,
  signer: KeyPairSigner,
): Promise<AirshipDropJob> {
  const recipients =
    validateRecipients(
      request.recipients,
    );

  if (
    request.delivery !== "airship" &&
    request.delivery !== "standard"
  ) {
    throw new Error(
      "Choose AirShip or standard airdrop delivery",
    );
  }

  if (
    activeSenders.has(request.sender)
  ) {
    throw new Error(
      "This managed wallet already has an airdrop in progress",
    );
  }

  if (
    request.network === "mainnet" &&
    request.mainnetConfirmed !== true
  ) {
    throw new Error(
      "Mainnet airdrops require explicit confirmation",
    );
  }

  if (
    signer.address !== request.sender
  ) {
    throw new Error(
      "Managed sender does not match the signing key",
    );
  }

  const tokens =
    await listAirshipTokens(
      rpcUrl,
      request.sender,
    );

  const token = tokens.find(
    (item) =>
      item.mint === request.mint,
  );

  if (!token) {
    throw new Error(
      "The selected token is not held by this managed wallet",
    );
  }

  if (!token.supported) {
    throw new Error(
      "This Token-2022 mint uses an extension this airdrop flow does not support",
    );
  }

  const amount =
    parseTokenAmount(
      request.amountPerRecipient,
      token.decimals,
    );

  if (
    request.delivery === "airship" &&
    amount >
      BigInt(
        Number.MAX_SAFE_INTEGER,
      )
  ) {
    throw new Error(
      "Per-recipient amount exceeds AirShip's safe integer limit",
    );
  }

  const totalAmount =
    amount *
    BigInt(recipients.length);

  if (
    totalAmount >
    BigInt(token.balanceBaseUnits)
  ) {
    throw new Error(
      "Token balance is too low for this distribution",
    );
  }

  const now =
    new Date().toISOString();

  const recipientsPerTransaction =
    request.delivery === "airship"
      ? MAX_ADDRESSES_PER_TRANSACTION
      : MAX_STANDARD_RECIPIENTS_PER_TRANSACTION;

  const job: AirshipDropJob = {
    id: randomUUID(),

    network:
      request.network,

    delivery:
      request.delivery,

    sender:
      request.sender,

    mint:
      request.mint,

    symbol:
      token.symbol,

    decimals:
      token.decimals,

    recipientCount:
      recipients.length,

    amountPerRecipientBaseUnits:
      amount.toString(),

    totalAmountBaseUnits:
      totalAmount.toString(),

    totalTransactions:
      Math.ceil(
        recipients.length /
          recipientsPerTransaction,
      ),

    sentTransactions: 0,

    confirmedTransactions: 0,

    state: "queued",

    signatures: [],

    createdAt: now,

    updatedAt: now,
  };

  jobs.set(
    job.id,
    job,
  );

  activeSenders.add(
    request.sender,
  );

  const runner =
    request.delivery === "airship"
      ? runAirshipDrop
      : runStandardDrop;

  void runner(
    rpcUrl,
    job,
    signer,
    recipients,
    amount,
    token.tokenProgram,
  )
    .catch((error: unknown) =>
      updateJob(job.id, {
        state: "failed",

        error:
          error instanceof Error
            ? error.message
            : "Airdrop failed",
      }),
    )
    .finally(() =>
      activeSenders.delete(
        request.sender,
      ),
    );

  return job;
}

export async function decompressAirshipTokens(
  rpcUrl: string,
  request: DecompressAirshipTokensRequest,
  signer: KeyPairSigner,
): Promise<AirshipDecompressionResult> {
  const owner =
    address(
      request.owner.trim(),
    );

  const mint =
    address(
      request.mint.trim(),
    );

  if (
    signer.address !== owner
  ) {
    throw new Error(
      "Managed owner does not match the signing key",
    );
  }

  if (
    request.network === "mainnet" &&
    request.mainnetConfirmed !== true
  ) {
    throw new Error(
      "Mainnet decompression requires explicit confirmation",
    );
  }

  if (
    activeSenders.has(owner)
  ) {
    throw new Error(
      "This managed wallet already has an AirShip action in progress",
    );
  }

  activeSenders.add(owner);

  try {
    const rpc =
      createSolanaRpc(rpcUrl);

    const [
      mintAccount,
      supply,
    ] = await Promise.all([
      rpc
        .getAccountInfo(
          mint,
          {
            commitment:
              "confirmed",

            encoding:
              "base64",
          },
        )
        .send(),

      rpc
        .getTokenSupply(
          mint,
          {
            commitment:
              "confirmed",
          },
        )
        .send(),
    ]);

    if (
      !mintAccount.value
    ) {
      throw new Error(
        "Token mint was not found",
      );
    }

    const mintOwner =
      String(
        mintAccount.value.owner,
      );

    const tokenProgram =
      mintOwner ===
      TOKEN_PROGRAM_ADDRESS
        ? "classic"
        : mintOwner ===
            TOKEN_2022_PROGRAM_ADDRESS
          ? "token2022"
          : null;

    if (!tokenProgram) {
      throw new Error(
        "Mint is not owned by the SPL Token or Token-2022 program",
      );
    }

    const amount =
      parseTokenAmount(
        request.amount,
        supply.value.decimals,
      );

    const tokenProgramAddress =
      tokenProgram === "classic"
        ? TOKEN_PROGRAM_ADDRESS
        : TOKEN_2022_PROGRAM_ADDRESS;

    const [destination] =
      tokenProgram === "classic"
        ? await findAssociatedTokenPda({
            owner,
            mint,

            tokenProgram:
              TOKEN_PROGRAM_ADDRESS,
          })
        : await findToken2022AssociatedTokenPda({
            owner,
            mint,

            tokenProgram:
              TOKEN_2022_PROGRAM_ADDRESS,
          });

    const outputStateTree =
      await getAirshipStateTree(
        rpcUrl,
      );

    const decompressInstruction =
      await getAirshipDecompressInstruction(
        {
          rpcUrl,

          feePayer:
            signer,

          destination,

          amount,

          mint,

          tokenProgram:
            tokenProgramAddress,

          outputStateTree,
        },
      );

    const createDestinationInstruction =
      tokenProgram === "classic"
        ? getCreateAssociatedTokenIdempotentInstruction(
            {
              payer: signer,
              ata: destination,
              owner,
              mint,
            },
          )
        : getCreateToken2022AssociatedTokenIdempotentInstruction(
            {
              payer: signer,
              ata: destination,
              owner,
              mint,
            },
          );

    const signature =
      await sendKitInstructions(
        rpcUrl,
        signer,
        [
          createDestinationInstruction,
          decompressInstruction,
        ],
        DECOMPRESS_COMPUTE_UNIT_LIMIT,
      );

    return {
      network:
        request.network,

      owner,

      mint,

      amountBaseUnits:
        amount.toString(),

      destinationTokenAccount:
        destination,

      signature,
    };
  } finally {
    activeSenders.delete(
      owner,
    );
  }
}

export function getAirshipDrop(
  id: string,
): AirshipDropJob {
  const job =
    jobs.get(id);

  if (!job) {
    throw new Error(
      "AirShip distribution not found or server restarted",
    );
  }

  return job;
}

async function runAirshipDrop(
  rpcUrl: string,
  job: AirshipDropJob,
  signer: KeyPairSigner,
  recipients: Address[],
  amount: bigint,
  tokenProgram: AirshipToken["tokenProgram"],
): Promise<void> {
  updateJob(
    job.id,
    {
      state: "preparing",
    },
  );

  const rpc =
    createSolanaRpc(rpcUrl);

  const mint =
    address(job.mint);

  const tokenProgramAddress =
    tokenProgram === "classic"
      ? TOKEN_PROGRAM_ADDRESS
      : TOKEN_2022_PROGRAM_ADDRESS;

  const [source] =
    tokenProgram === "classic"
      ? await findAssociatedTokenPda(
          {
            owner:
              signer.address,

            mint,

            tokenProgram:
              TOKEN_PROGRAM_ADDRESS,
          },
        )
      : await findToken2022AssociatedTokenPda(
          {
            owner:
              signer.address,

            mint,

            tokenProgram:
              TOKEN_2022_PROGRAM_ADDRESS,
          },
        );

  const tokenPool =
    address(
      getAirshipTokenPoolAddress(
        mint,
      ),
    );

  const [
    sourceAccount,
    poolAccount,
  ] = await Promise.all([
    rpc
      .getAccountInfo(
        source,
        {
          commitment:
            "confirmed",

          encoding:
            "base64",
        },
      )
      .send(),

    rpc
      .getAccountInfo(
        tokenPool,
        {
          commitment:
            "confirmed",

          encoding:
            "base64",
        },
      )
      .send(),
  ]);

  const setupInstructions:
    Instruction[] = [];

  if (
    sourceAccount.value === null
  ) {
    setupInstructions.push(
      tokenProgram === "classic"
        ? getCreateAssociatedTokenIdempotentInstruction(
            {
              payer:
                signer,

              ata:
                source,

              owner:
                signer.address,

              mint,
            },
          )
        : getCreateToken2022AssociatedTokenIdempotentInstruction(
            {
              payer:
                signer,

              ata:
                source,

              owner:
                signer.address,

              mint,
            },
          ),
    );
  }

  if (
    poolAccount.value === null
  ) {
    setupInstructions.push(
      await getAirshipCreatePoolInstruction(
        {
          feePayer:
            signer,

          mint,

          tokenProgram:
            tokenProgramAddress,
        },
      ),
    );
  }

  if (
    setupInstructions.length >
    0
  ) {
    await sendKitInstructions(
      rpcUrl,
      signer,
      setupInstructions,
      COMPUTE_UNIT_LIMIT,
    );
  }

  const outputStateTree =
    await getAirshipStateTree(
      rpcUrl,
    );

  updateJob(
    job.id,
    {
      state: "sending",
    },
  );

  await runWithConcurrency(
    Math.ceil(recipients.length / MAX_ADDRESSES_PER_TRANSACTION),
    AIRDROP_BATCH_CONCURRENCY,
    async (batchIndex) => {
    const offset = batchIndex * MAX_ADDRESSES_PER_TRANSACTION;
    const batch =
      recipients.slice(
        offset,
        offset +
          MAX_ADDRESSES_PER_TRANSACTION,
      );

    const instructions:
      Instruction[] = [];

    for (
      let index = 0;
      index < batch.length;
      index +=
        MAX_ADDRESSES_PER_INSTRUCTION
    ) {
      instructions.push(
        await getAirshipCompressInstruction(
          {
            feePayer:
              signer,

            source,

            recipients:
              batch.slice(
                index,
                index +
                  MAX_ADDRESSES_PER_INSTRUCTION,
              ),

            amount,

            mint,

            tokenProgram:
              tokenProgramAddress,

            outputStateTree,
          },
        ),
      );
    }

    const signature =
      await sendKitInstructions(
        rpcUrl,
        signer,
        instructions,
        COMPUTE_UNIT_LIMIT,
      );

    const current =
      getAirshipDrop(
        job.id,
      );

    updateJob(
      job.id,
      {
        sentTransactions:
          current.sentTransactions +
          1,

        confirmedTransactions:
          current.confirmedTransactions +
          1,

        signatures: [
          ...current.signatures,
          signature,
        ],
      },
    );
    },
  );

  updateJob(
    job.id,
    {
      state:
        "confirmed",
    },
  );
}

async function runStandardDrop(
  rpcUrl: string,
  job: AirshipDropJob,
  signer: KeyPairSigner,
  recipients: Address[],
  amount: bigint,
  tokenProgram: AirshipToken["tokenProgram"],
): Promise<void> {
  updateJob(
    job.id,
    {
      state:
        "preparing",
    },
  );

  const mint =
    address(job.mint);

  const tokenProgramAddress =
    tokenProgram === "classic"
      ? TOKEN_PROGRAM_ADDRESS
      : TOKEN_2022_PROGRAM_ADDRESS;

  const [source] =
    tokenProgram === "classic"
      ? await findAssociatedTokenPda(
          {
            owner:
              signer.address,

            mint,

            tokenProgram:
              TOKEN_PROGRAM_ADDRESS,
          },
        )
      : await findToken2022AssociatedTokenPda(
          {
            owner:
              signer.address,

            mint,

            tokenProgram:
              TOKEN_2022_PROGRAM_ADDRESS,
          },
        );

  updateJob(
    job.id,
    {
      state:
        "sending",
    },
  );

  await runWithConcurrency(
    Math.ceil(recipients.length / MAX_STANDARD_RECIPIENTS_PER_TRANSACTION),
    AIRDROP_BATCH_CONCURRENCY,
    async (batchIndex) => {
    const offset = batchIndex * MAX_STANDARD_RECIPIENTS_PER_TRANSACTION;
    const instructions:
      Instruction[] = [];

    const batch =
      recipients.slice(
        offset,
        offset +
          MAX_STANDARD_RECIPIENTS_PER_TRANSACTION,
      );

    for (
      const recipient of batch
    ) {
      const [destination] =
        tokenProgram === "classic"
          ? await findAssociatedTokenPda(
              {
                owner:
                  recipient,

                mint,

                tokenProgram:
                  TOKEN_PROGRAM_ADDRESS,
              },
            )
          : await findToken2022AssociatedTokenPda(
              {
                owner:
                  recipient,

                mint,

                tokenProgram:
                  TOKEN_2022_PROGRAM_ADDRESS,
              },
            );

      instructions.push(
        tokenProgram === "classic"
          ? getCreateAssociatedTokenIdempotentInstruction(
              {
                payer:
                  signer,

                ata:
                  destination,

                owner:
                  recipient,

                mint,

                tokenProgram:
                  tokenProgramAddress,
              },
            )
          : getCreateToken2022AssociatedTokenIdempotentInstruction(
              {
                payer:
                  signer,

                ata:
                  destination,

                owner:
                  recipient,

                mint,

                tokenProgram:
                  tokenProgramAddress,
              },
            ),

        tokenProgram === "classic"
          ? getTransferCheckedInstruction(
              {
                source,

                mint,

                destination,

                authority:
                  signer,

                amount,

                decimals:
                  job.decimals,
              },
            )
          : getTransferCheckedToken2022Instruction(
              {
                source,

                mint,

                destination,

                authority:
                  signer,

                amount,

                decimals:
                  job.decimals,
              },
            ),
      );
    }

    const signature =
      await sendKitInstructions(
        rpcUrl,
        signer,
        instructions,
        COMPUTE_UNIT_LIMIT,
      );

    const current =
      getAirshipDrop(
        job.id,
      );

    updateJob(
      job.id,
      {
        sentTransactions:
          current.sentTransactions +
          1,

        confirmedTransactions:
          current.confirmedTransactions +
          1,

        signatures: [
          ...current.signatures,
          signature,
        ],
      },
    );
    },
  );

  updateJob(
    job.id,
    {
      state:
        "confirmed",
    },
  );
}

async function runTokenCollection(
  rpcUrl: string,
  job: TokenCollectionJob,
  sources: TokenCollectionPreviewSource[],
  signers: Map<string, KeyPairSigner>,
): Promise<void> {
  updateCollectionJob(job.id, { state: "preparing" });
  const destinationSigner = signers.get(job.destination);
  if (!destinationSigner) throw new Error("Destination signing key is unavailable");
  const mint = address(job.mint);
  const destination = address(job.destination);
  const destinationTokenAccount = address(job.destinationTokenAccount);
  const tokenProgramAddress = job.tokenProgram === "classic" ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
  const batches: TokenCollectionPreviewSource[][] = [];
  for (let offset = 0; offset < sources.length; offset += MAX_COLLECTION_SOURCES_PER_TRANSACTION) {
    batches.push(sources.slice(offset, offset + MAX_COLLECTION_SOURCES_PER_TRANSACTION));
  }
  updateCollectionJob(job.id, { state: "sending", totalTransactions: batches.length });
  await Promise.all(batches.map(async (batch) => {
    const instructions: Instruction[] = [];
    if (batch.some((source) => BigInt(source.amountBaseUnits) > 0n)) {
      instructions.push(job.tokenProgram === "classic"
        ? getCreateAssociatedTokenIdempotentInstruction({ payer: destinationSigner, ata: destinationTokenAccount, owner: destination, mint, tokenProgram: tokenProgramAddress })
        : getCreateToken2022AssociatedTokenIdempotentInstruction({ payer: destinationSigner, ata: destinationTokenAccount, owner: destination, mint, tokenProgram: tokenProgramAddress }));
    }
    for (const source of batch) {
      const ownerSigner = signers.get(source.owner);
      if (!ownerSigner) throw new Error(`Signing key unavailable for ${source.owner}`);
      const sourceAccount = address(source.tokenAccount);
      const amount = BigInt(source.amountBaseUnits);
      if (amount > 0n) instructions.push(job.tokenProgram === "classic"
        ? getTransferCheckedInstruction({ source: sourceAccount, mint, destination: destinationTokenAccount, authority: ownerSigner, amount, decimals: job.decimals })
        : getTransferCheckedToken2022Instruction({ source: sourceAccount, mint, destination: destinationTokenAccount, authority: ownerSigner, amount, decimals: job.decimals }));
      if (source.willClose) instructions.push(job.tokenProgram === "classic"
        ? getCloseAccountInstruction({ account: sourceAccount, destination, owner: ownerSigner })
        : getCloseToken2022AccountInstruction({ account: sourceAccount, destination, owner: ownerSigner }));
    }
    let signature = "";
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try { signature = await sendKitInstructions(rpcUrl, destinationSigner, instructions, COMPUTE_UNIT_LIMIT); break; }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (attempt === 2 || !/blockhash[^\n]*not found/i.test(message)) throw reason;
      }
    }
    const current = getTokenCollection(job.id);
    updateCollectionJob(job.id, {
      sentTransactions: current.sentTransactions + 1,
      confirmedTransactions: current.confirmedTransactions + 1,
      closedAccounts: current.closedAccounts + batch.filter((source) => source.willClose).length,
      reclaimedRentLamports: (BigInt(current.reclaimedRentLamports) + batch.filter((source) => source.willClose).reduce((sum, source) => sum + BigInt(source.rentLamports), 0n)).toString(),
      signatures: [...current.signatures, signature],
    });
  }));
  updateCollectionJob(job.id, { state: "confirmed" });
}

async function sendKitInstructions(
  rpcUrl: string,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  computeUnitLimit =
    COMPUTE_UNIT_LIMIT,
): Promise<string> {
  const latest =
    await rpcCall<LatestBlockhash>(
      rpcUrl,
      "getLatestBlockhash",
      [
        {
          commitment:
            "confirmed",
        },
      ],
    );

  const message =
    pipe(
      createTransactionMessage({
        version: 1,
      }),

      (value) =>
        setTransactionMessageFeePayerSigner(
          feePayer,
          value,
        ),

      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash:
              blockhash(
                latest.value.blockhash,
              ),

            lastValidBlockHeight:
              BigInt(
                latest.value
                  .lastValidBlockHeight,
              ),
          },

          value,
        ),

      (value) =>
        appendTransactionMessageInstructions(
          instructions,
          value,
        ),

      (value) =>
        setTransactionMessageConfig(
          {
            computeUnitLimit,

            loadedAccountsDataSizeLimit:
              LOADED_ACCOUNTS_DATA_SIZE_LIMIT,

            priorityFeeLamports:
              PRIORITY_FEE_LAMPORTS,
          },

          value,
        ),
    );

  const signed =
    await signTransactionMessageWithSigners(
      message,
    );

  const signature =
    await sendRpc(
      rpcUrl,
      getBase64EncodedWireTransaction(
        signed,
      ),
      false,
    );

  const status =
    await waitForConfirmation(
      rpcUrl,
      signature,

      BigInt(
        latest.value
          .lastValidBlockHeight,
      ),
    );

  if (
    status !== "confirmed"
  ) {
    throw new Error(
      `Airdrop transaction ${signature} is still pending; wait before retrying`,
    );
  }

  return signature;
}

function updateJob(
  id: string,
  patch: Partial<AirshipDropJob>,
): void {
  const current =
    jobs.get(id);

  if (current) {
    jobs.set(
      id,
      {
        ...current,
        ...patch,

        updatedAt:
          new Date().toISOString(),
      },
    );
  }
}

function updateCollectionJob(id: string, patch: Partial<TokenCollectionJob>): void {
  const current = collectionJobs.get(id);
  if (current) collectionJobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function excludedCollectionSource(owner: Address, tokenAccount: Address, reason: string): TokenCollectionPreviewSource {
  return { owner, tokenAccount, balanceBaseUnits: "0", balance: "0", amountBaseUnits: "0", amount: "0", rentLamports: "0", selected: false, willClose: false, eligible: false, reason };
}

function formatTokenUnits(value: bigint, decimals: number): string {
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function validateRecipients(
  values: unknown,
): Address[] {
  if (
    !Array.isArray(values) ||
    values.length === 0
  ) {
    throw new Error(
      "Add at least one recipient",
    );
  }

  if (
    values.length >
    MAX_RECIPIENTS
  ) {
    throw new Error(
      `AirShip supports up to ${MAX_RECIPIENTS.toLocaleString()} recipients per web distribution`,
    );
  }

  const unique =
    new Set<Address>();

  values.forEach(
    (value, index) => {
      if (
        typeof value !== "string"
      ) {
        throw new Error(
          `Recipient ${index + 1} is not an address`,
        );
      }

      let normalized: Address;

      try {
        normalized =
          address(
            value.trim(),
          );
      } catch {
        throw new Error(
          `Invalid recipient on line ${index + 1}: ${value}`,
        );
      }

      if (
        unique.has(
          normalized,
        )
      ) {
        throw new Error(
          `Duplicate recipient on line ${index + 1}: ${normalized}`,
        );
      }

      unique.add(
        normalized,
      );
    },
  );

  return [
    ...unique,
  ];
}

function parseTokenAmount(
  value: string,
  decimals: number,
): bigint {
  const normalized =
    value.trim();

  if (
    !/^\d+(?:\.\d+)?$/.test(
      normalized,
    )
  ) {
    throw new Error(
      "Amount per recipient must be a positive decimal number",
    );
  }

  const [
    whole = "0",
    fraction = "",
  ] =
    normalized.split(
      ".",
    );

  if (
    fraction.length >
    decimals
  ) {
    throw new Error(
      `Amount has more than ${decimals} decimal places`,
    );
  }

  const units =
    BigInt(whole) *
      10n **
        BigInt(decimals) +
    BigInt(
      (
        fraction +
        "0".repeat(
          decimals,
        )
      ).slice(
        0,
        decimals,
      ) || "0",
    );

  if (
    units <= 0n
  ) {
    throw new Error(
      "Amount per recipient must be greater than zero",
    );
  }

  return units;
}

async function heliusDasCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<
    string,
    unknown
  >,
): Promise<T> {
  const response =
    await fetch(
      rpcUrl,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            jsonrpc:
              "2.0",

            id:
              "airship-kit",

            method,

            params,
          }),
      },
    );

  const body =
    (await response.json()) as JsonRpcResponse<T>;

  if (
    !response.ok ||
    body.error ||
    body.result === undefined
  ) {
    throw new Error(
      body.error?.message ??
        `Helius ${method} request failed (${response.status})`,
    );
  }

  return body.result;
}

function shortAddress(
  value: string,
): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
