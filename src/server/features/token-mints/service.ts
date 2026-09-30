import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  isSome,
  lamports,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  AuthorityType,
  TOKEN_PROGRAM_ADDRESS,
  fetchAllMaybeMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getBurnCheckedInstruction,
  getFreezeAccountInstruction,
  getSetAuthorityInstruction,
  getThawAccountInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  AuthorityType as Token2022AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  fetchAllMaybeMint as fetchAllMaybeToken2022Mint,
  findAssociatedTokenPda as findToken2022AssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction as getCreateToken2022AssociatedTokenIdempotentInstruction,
  getFreezeAccountInstruction as getFreezeToken2022AccountInstruction,
  getInitializeMintInstruction as getInitializeToken2022MintInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeTokenMetadataInstruction,
  getMintSize as getToken2022MintSize,
  getMintToInstruction as getMintToToken2022Instruction,
  getRemoveTokenMetadataKeyInstruction,
  getBurnCheckedInstruction as getBurnCheckedToken2022Instruction,
  getSetAuthorityInstruction as getSetToken2022AuthorityInstruction,
  getThawAccountInstruction as getThawToken2022AccountInstruction,
  getTransferCheckedInstruction as getTransferCheckedToken2022Instruction,
  getUpdateTokenMetadataFieldInstruction,
  getUpdateTokenMetadataUpdateAuthorityInstruction,
  tokenMetadataField,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import {
  V1_MAX_COMPUTE_UNIT_LIMIT,
  V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  buildV1TransactionMessage,
} from "@solana-workbench/transaction-v1";
import { sendRpc, waitForConfirmation, type Network } from "@solana-workbench/delivery-sdk";
import type { CreateTokenMintRequest, ManageTokenMintRequest, StoredTokenMint, TokenMintActionResult, TrackedTokenMint } from "../../../shared/token-mints";
import { decimalAmountToBaseUnits } from "../../../shared/token-mints";
import { rpcCall } from "../../infrastructure/rpc";
import { listStoredTokenMints, recordTokenMint, updateTokenMint } from "./registry";

interface LatestBlockhash {
  value: { blockhash: string; lastValidBlockHeight: number };
}

interface SimulationResult {
  value: { err: unknown; logs?: string[] | null; unitsConsumed?: number; loadedAccountsDataSize?: number };
}

export interface ValidatedTokenMintRequest extends Omit<CreateTokenMintRequest, "freezeAuthority"> {
  freezeAuthority: string | null;
  initialSupplyBaseUnits: bigint;
  tokenProgram: "classic" | "token2022";
  metadataUri: string;
  imageUrl: string;
}

export function validateTokenMintRequest(input: CreateTokenMintRequest): ValidatedTokenMintRequest {
  if (input.network !== "devnet" && input.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
  if (input.network === "mainnet" && input.mainnetConfirmed !== true) throw new Error("Mainnet mint creation requires explicit confirmation");
  if (input.transactionVersion !== 0 && input.transactionVersion !== 1) throw new Error("Transaction version must be 0 or 1");
  const name = input.name.trim();
  const symbol = input.symbol.trim();
  if (name.length < 1 || name.length > 64) throw new Error("Local name must contain 1 to 64 characters");
  if (symbol.length < 1 || symbol.length > 12) throw new Error("Local symbol must contain 1 to 12 characters");
  address(input.mintAuthority);
  const freezeAuthority = input.freezeAuthority === undefined ? input.mintAuthority : input.freezeAuthority;
  if (freezeAuthority !== null) address(freezeAuthority);
  if (input.revokeFreezeAuthority && freezeAuthority === null) throw new Error("A freeze authority is required before it can be revoked");
  const tokenProgram = input.tokenProgram ?? "classic";
  if (tokenProgram !== "classic" && tokenProgram !== "token2022") throw new Error("Token program must be classic or token2022");
  const metadataUri = (input.metadataUri ?? "").trim();
  const imageUrl = (input.imageUrl ?? "").trim();
  if (metadataUri.length > 500) throw new Error("Metadata URI must be 500 characters or fewer");
  if (imageUrl.length > 500) throw new Error("Image URL must be 500 characters or fewer");
  if (tokenProgram === "classic" && (metadataUri || imageUrl)) throw new Error("On-chain metadata requires Token-2022");
  return {
    ...input,
    name,
    symbol,
    freezeAuthority,
    tokenProgram,
    metadataUri,
    imageUrl,
    initialSupplyBaseUnits: decimalAmountToBaseUnits(input.initialSupply || "0", input.decimals),
  };
}

export async function buildTokenMintInstructions(input: {
  mint: KeyPairSigner;
  mintAuthority: KeyPairSigner;
  freezeAuthority: Address | null;
  freezeAuthoritySigner: KeyPairSigner | null;
  decimals: number;
  amount: bigint;
  rentLamports: number;
  revokeMintAuthority: boolean;
  revokeFreezeAuthority: boolean;
  tokenProgram?: "classic" | "token2022";
  name?: string;
  symbol?: string;
  metadataUri?: string;
  imageUrl?: string;
}): Promise<{ instructions: Instruction[]; associatedTokenAccount?: Address }> {
  if (input.tokenProgram === "token2022") return buildToken2022MintInstructions(input);
  const instructions: Instruction[] = [
    getCreateAccountInstruction({
      payer: input.mintAuthority,
      newAccount: input.mint,
      lamports: input.rentLamports,
      space: getMintSize(),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: input.mint.address,
      decimals: input.decimals,
      mintAuthority: input.mintAuthority.address,
      freezeAuthority: input.freezeAuthority,
    }),
  ];
  let associatedTokenAccount: Address | undefined;
  if (input.amount > 0n) {
    [associatedTokenAccount] = await findAssociatedTokenPda({
      owner: input.mintAuthority.address,
      mint: input.mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: input.mintAuthority,
        ata: associatedTokenAccount,
        owner: input.mintAuthority.address,
        mint: input.mint.address,
      }),
      getMintToInstruction({
        mint: input.mint.address,
        token: associatedTokenAccount,
        mintAuthority: input.mintAuthority,
        amount: input.amount,
      }),
    );
  }
  if (input.revokeMintAuthority) {
    instructions.push(getSetAuthorityInstruction({
      owned: input.mint.address,
      owner: input.mintAuthority,
      authorityType: AuthorityType.MintTokens,
      newAuthority: null,
    }));
  }
  if (input.revokeFreezeAuthority) {
    if (!input.freezeAuthoritySigner) throw new Error("A freeze authority signer is required before it can be revoked");
    instructions.push(getSetAuthorityInstruction({
      owned: input.mint.address,
      owner: input.freezeAuthoritySigner,
      authorityType: AuthorityType.FreezeAccount,
      newAuthority: null,
    }));
  }
  return { instructions, ...(associatedTokenAccount ? { associatedTokenAccount } : {}) };
}

async function buildToken2022MintInstructions(input: {
  mint: KeyPairSigner;
  mintAuthority: KeyPairSigner;
  freezeAuthority: Address | null;
  freezeAuthoritySigner: KeyPairSigner | null;
  decimals: number;
  amount: bigint;
  rentLamports: number;
  revokeMintAuthority: boolean;
  revokeFreezeAuthority: boolean;
  name?: string;
  symbol?: string;
  metadataUri?: string;
  imageUrl?: string;
}): Promise<{ instructions: Instruction[]; associatedTokenAccount?: Address }> {
  const metadataPointer = extension("MetadataPointer", {
    authority: input.mintAuthority.address,
    metadataAddress: input.mint.address,
  });
  const instructions: Instruction[] = [
    getCreateAccountInstruction({
      payer: input.mintAuthority,
      newAccount: input.mint,
      lamports: input.rentLamports,
      space: getToken2022MintSize([metadataPointer]),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMetadataPointerInstruction({
      mint: input.mint.address,
      authority: input.mintAuthority.address,
      metadataAddress: input.mint.address,
    }),
    getInitializeToken2022MintInstruction({
      mint: input.mint.address,
      decimals: input.decimals,
      mintAuthority: input.mintAuthority.address,
      freezeAuthority: input.freezeAuthority,
    }),
    getInitializeTokenMetadataInstruction({
      metadata: input.mint.address,
      updateAuthority: input.mintAuthority.address,
      mint: input.mint.address,
      mintAuthority: input.mintAuthority,
      name: input.name ?? "",
      symbol: input.symbol ?? "",
      uri: input.metadataUri ?? "",
    }),
  ];
  if (input.imageUrl) {
    instructions.push(getUpdateTokenMetadataFieldInstruction({
      metadata: input.mint.address,
      updateAuthority: input.mintAuthority,
      field: tokenMetadataField("Key", ["image"]),
      value: input.imageUrl,
    }));
  }
  let associatedTokenAccount: Address | undefined;
  if (input.amount > 0n) {
    [associatedTokenAccount] = await findToken2022AssociatedTokenPda({
      owner: input.mintAuthority.address,
      mint: input.mint.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    instructions.push(
      getCreateToken2022AssociatedTokenIdempotentInstruction({
        payer: input.mintAuthority,
        ata: associatedTokenAccount,
        owner: input.mintAuthority.address,
        mint: input.mint.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getMintToToken2022Instruction({
        mint: input.mint.address,
        token: associatedTokenAccount,
        mintAuthority: input.mintAuthority,
        amount: input.amount,
      }),
    );
  }
  if (input.revokeMintAuthority) instructions.push(getSetToken2022AuthorityInstruction({
    owned: input.mint.address,
    owner: input.mintAuthority,
    authorityType: Token2022AuthorityType.MintTokens,
    newAuthority: null,
  }));
  if (input.revokeFreezeAuthority) {
    if (!input.freezeAuthoritySigner) throw new Error("A freeze authority signer is required before it can be revoked");
    instructions.push(getSetToken2022AuthorityInstruction({
      owned: input.mint.address,
      owner: input.freezeAuthoritySigner,
      authorityType: Token2022AuthorityType.FreezeAccount,
      newAuthority: null,
    }));
  }
  return { instructions, ...(associatedTokenAccount ? { associatedTokenAccount } : {}) };
}

export async function createTokenMint(
  rpcUrl: string,
  request: CreateTokenMintRequest,
  mintAuthority: KeyPairSigner,
  freezeAuthoritySigner: KeyPairSigner | null,
): Promise<TrackedTokenMint> {
  const input = validateTokenMintRequest(request);
  if (mintAuthority.address !== input.mintAuthority) throw new Error("Mint authority signer does not match the request");
  if (input.freezeAuthority !== null && freezeAuthoritySigner?.address !== input.freezeAuthority) {
    throw new Error("Freeze authority signer does not match the request");
  }
  const mint = await generateKeyPairSigner(true);
  const rentSize = input.tokenProgram === "token2022"
    ? getToken2022MintSize(token2022MetadataExtensions(
        mint.address,
        mintAuthority.address,
        input.name,
        input.symbol,
        input.metadataUri,
        input.imageUrl,
      ))
    : getMintSize();
  const rentLamports = await rpcCall<number>(rpcUrl, "getMinimumBalanceForRentExemption", [rentSize]);
  const { instructions, associatedTokenAccount } = await buildTokenMintInstructions({
    mint,
    mintAuthority,
    freezeAuthority: input.freezeAuthority === null ? null : address(input.freezeAuthority),
    freezeAuthoritySigner,
    decimals: input.decimals,
    amount: input.initialSupplyBaseUnits,
    rentLamports,
    revokeMintAuthority: input.revokeMintAuthority,
    revokeFreezeAuthority: input.revokeFreezeAuthority,
    tokenProgram: input.tokenProgram,
    name: input.name,
    symbol: input.symbol,
    metadataUri: input.metadataUri,
    imageUrl: input.imageUrl,
  });
  const latest = await rpcCall<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const lifetime = {
    blockhash: blockhash(latest.value.blockhash),
    lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
  };
  const provisional = buildUnsignedTokenMintTransaction(input.transactionVersion, mintAuthority, lifetime, instructions, {
    computeUnitLimit: V1_MAX_COMPUTE_UNIT_LIMIT,
    loadedAccountsDataSizeLimit: V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  });
  const estimate = await simulateTransaction(rpcUrl, provisional);
  const computeUnitLimit = Math.min(V1_MAX_COMPUTE_UNIT_LIMIT, Math.max(1_000, Math.ceil(estimate.units * 1.1)));
  const loadedAccountsDataSizeLimit = Math.min(
    V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    Math.max(1, Math.ceil((estimate.loadedAccountsDataSize ?? 1) * 1.1)),
  );
  const unsigned = buildUnsignedTokenMintTransaction(input.transactionVersion, mintAuthority, lifetime, instructions, {
    computeUnitLimit,
    loadedAccountsDataSizeLimit,
  });
  assertIsTransactionWithinSizeLimit(unsigned);
  await simulateTransaction(rpcUrl, unsigned);
  const signers = [mint, mintAuthority];
  if (input.revokeFreezeAuthority && freezeAuthoritySigner && freezeAuthoritySigner.address !== mintAuthority.address) {
    signers.push(freezeAuthoritySigner);
  }
  const signed = await partiallySignTransactionWithSigners(signers, unsigned);
  const signature = await sendRpc(rpcUrl, getBase64EncodedWireTransaction(signed), false);
  const confirmation = await waitForConfirmation(rpcUrl, signature, lifetime.lastValidBlockHeight);
  if (confirmation !== "confirmed") throw new Error(`Mint transaction ${signature} is still pending; refresh before retrying`);
  const stored: StoredTokenMint = {
    mint: mint.address,
    ...(associatedTokenAccount ? { associatedTokenAccount } : {}),
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals,
    initialSupplyBaseUnits: input.initialSupplyBaseUnits.toString(),
    network: input.network,
    transactionVersion: input.transactionVersion,
    mintAuthorityAtCreation: input.mintAuthority,
    freezeAuthorityAtCreation: input.freezeAuthority,
    mintAuthorityRevoked: input.revokeMintAuthority,
    freezeAuthorityRevoked: input.revokeFreezeAuthority,
    creationSignature: signature,
    createdAt: new Date().toISOString(),
    tokenProgram: input.tokenProgram,
    ...(input.metadataUri ? { metadataUri: input.metadataUri } : {}),
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
  };
  await recordTokenMint(stored);
  return enrichTokenMints(rpcUrl, [stored]).then((items) => items[0]!);
}

function token2022MetadataExtensions(
  mint: Address,
  authority: Address,
  name: string,
  symbol: string,
  uri: string,
  imageUrl: string,
): ExtensionArgs[] {
  return [
    extension("MetadataPointer", { authority, metadataAddress: mint }),
    extension("TokenMetadata", {
      updateAuthority: authority,
      mint,
      name,
      symbol,
      uri,
      additionalMetadata: new Map(imageUrl ? [["image", imageUrl]] : []),
    }),
  ];
}

export async function listTokenMints(rpcUrl: string, network: Network): Promise<TrackedTokenMint[]> {
  const stored = (await listStoredTokenMints()).filter((entry) => entry.network === network);
  return enrichTokenMints(rpcUrl, stored);
}

export async function manageTokenMint(
  rpcUrl: string,
  request: ManageTokenMintRequest,
  getManagedSigner: (signerAddress: string) => Promise<KeyPairSigner>,
): Promise<TokenMintActionResult> {
  if (request.network !== "devnet" && request.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
  if (request.transactionVersion !== 0 && request.transactionVersion !== 1) throw new Error("Transaction version must be 0 or 1");
  if (request.network === "mainnet" && request.mainnetConfirmed !== true) throw new Error("Mainnet token management requires explicit confirmation");
  address(request.mint);
  const stored = (await listStoredTokenMints()).find((entry) => entry.network === request.network && entry.mint === request.mint);
  if (!stored) throw new Error("Only tokens created through this workbench can be managed");
  if (request.action === "update-local") {
    if (stored.tokenProgram === "token2022") throw new Error("Use the on-chain metadata action for Token-2022 mints");
    const fields = validateMetadataFields(request.name, request.symbol, request.metadataUri, request.imageUrl);
    const updated = await updateTokenMint(request.network, request.mint, fields);
    return { token: (await enrichTokenMints(rpcUrl, [updated]))[0]! };
  }
  const live = (await enrichTokenMints(rpcUrl, [stored]))[0]!;
  if (live.liveStatus !== "available") throw new Error(live.liveError ?? "Current mint state is unavailable");
  const mint = address(stored.mint);
  const isToken2022 = stored.tokenProgram === "token2022";
  const tokenProgram = isToken2022 ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
  const findAta = isToken2022 ? findToken2022AssociatedTokenPda : findAssociatedTokenPda;
  const instructions: Instruction[] = [];
  let signer: KeyPairSigner;
  let registryUpdates: Partial<Pick<StoredTokenMint, "name" | "symbol" | "metadataUri" | "imageUrl">> | undefined;

  if (request.action === "update-metadata") {
    if (!isToken2022) throw new Error("Classic SPL tokens do not support Token-2022 metadata extensions");
    if (!live.metadataUpdateAuthority) throw new Error("The metadata update authority has been revoked");
    signer = await getManagedSigner(live.metadataUpdateAuthority);
    const fields = validateMetadataFields(request.name, request.symbol, request.metadataUri, request.imageUrl);
    const requiredRent = await rpcCall<number>(rpcUrl, "getMinimumBalanceForRentExemption", [
      getToken2022MintSize(token2022MetadataExtensions(mint, signer.address, fields.name, fields.symbol, fields.metadataUri ?? "", fields.imageUrl ?? "")),
    ]);
    const balance = await rpcCall<{ value: number }>(rpcUrl, "getBalance", [mint, { commitment: "confirmed" }]);
    if (requiredRent > balance.value) {
      instructions.push(getTransferSolInstruction({ source: signer, destination: mint, amount: lamports(BigInt(requiredRent - balance.value)) }));
    }
    instructions.push(
      getUpdateTokenMetadataFieldInstruction({ metadata: mint, updateAuthority: signer, field: tokenMetadataField("Name"), value: fields.name }),
      getUpdateTokenMetadataFieldInstruction({ metadata: mint, updateAuthority: signer, field: tokenMetadataField("Symbol"), value: fields.symbol }),
      getUpdateTokenMetadataFieldInstruction({ metadata: mint, updateAuthority: signer, field: tokenMetadataField("Uri"), value: fields.metadataUri ?? "" }),
    );
    instructions.push(fields.imageUrl
      ? getUpdateTokenMetadataFieldInstruction({ metadata: mint, updateAuthority: signer, field: tokenMetadataField("Key", ["image"]), value: fields.imageUrl })
      : getRemoveTokenMetadataKeyInstruction({ metadata: mint, updateAuthority: signer, idempotent: true, key: "image" }));
    registryUpdates = fields;
  } else if (request.action === "mint") {
    if (!live.mintAuthority) throw new Error("The mint authority has been revoked");
    signer = await getManagedSigner(live.mintAuthority);
    const recipient = address(request.recipient);
    const amount = decimalAmountToBaseUnits(request.amount, stored.decimals);
    if (amount === 0n) throw new Error("Mint amount must be greater than zero");
    const [destination] = await findAta({ owner: recipient, mint, tokenProgram });
    instructions.push(
      isToken2022
        ? getCreateToken2022AssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: recipient, mint, tokenProgram })
        : getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: recipient, mint, tokenProgram }),
      isToken2022
        ? getMintToToken2022Instruction({ mint, token: destination, mintAuthority: signer, amount })
        : getMintToInstruction({ mint, token: destination, mintAuthority: signer, amount }),
    );
  } else if (request.action === "transfer" || request.action === "burn") {
    signer = await getManagedSigner(request.owner);
    const owner = address(request.owner);
    const amount = decimalAmountToBaseUnits(request.amount, stored.decimals);
    if (amount === 0n) throw new Error(`${request.action === "burn" ? "Burn" : "Transfer"} amount must be greater than zero`);
    const [source] = await findAta({ owner, mint, tokenProgram });
    if (request.action === "burn") {
      instructions.push(isToken2022
        ? getBurnCheckedToken2022Instruction({ account: source, mint, authority: signer, amount, decimals: stored.decimals })
        : getBurnCheckedInstruction({ account: source, mint, authority: signer, amount, decimals: stored.decimals }));
    } else {
      const recipient = address(request.recipient);
      const [destination] = await findAta({ owner: recipient, mint, tokenProgram });
      instructions.push(
        isToken2022
          ? getCreateToken2022AssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: recipient, mint, tokenProgram })
          : getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: recipient, mint, tokenProgram }),
        isToken2022
          ? getTransferCheckedToken2022Instruction({ source, mint, destination, authority: signer, amount, decimals: stored.decimals })
          : getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount, decimals: stored.decimals }),
      );
    }
  } else if (request.action === "freeze" || request.action === "thaw") {
    if (!live.freezeAuthority) throw new Error("The freeze authority is not configured or has been revoked");
    signer = await getManagedSigner(live.freezeAuthority);
    const owner = address(request.owner);
    const [account] = await findAta({ owner, mint, tokenProgram });
    instructions.push(request.action === "freeze"
      ? isToken2022
        ? getFreezeToken2022AccountInstruction({ account, mint, owner: signer })
        : getFreezeAccountInstruction({ account, mint, owner: signer })
      : isToken2022
        ? getThawToken2022AccountInstruction({ account, mint, owner: signer })
        : getThawAccountInstruction({ account, mint, owner: signer }));
  } else if (request.action === "set-mint-authority" || request.action === "set-freeze-authority") {
    const current = request.action === "set-mint-authority" ? live.mintAuthority : live.freezeAuthority;
    if (!current) throw new Error(`The ${request.action === "set-mint-authority" ? "mint" : "freeze"} authority has been revoked`);
    signer = await getManagedSigner(current);
    if (request.newAuthority !== null) await getManagedSigner(request.newAuthority);
    const authorityType = request.action === "set-mint-authority"
      ? (isToken2022 ? Token2022AuthorityType.MintTokens : AuthorityType.MintTokens)
      : (isToken2022 ? Token2022AuthorityType.FreezeAccount : AuthorityType.FreezeAccount);
    instructions.push(isToken2022
      ? getSetToken2022AuthorityInstruction({ owned: mint, owner: signer, authorityType: authorityType as Token2022AuthorityType, newAuthority: request.newAuthority ? address(request.newAuthority) : null })
      : getSetAuthorityInstruction({ owned: mint, owner: signer, authorityType: authorityType as AuthorityType, newAuthority: request.newAuthority ? address(request.newAuthority) : null }));
  } else if (request.action === "set-metadata-authority") {
    if (!isToken2022) throw new Error("Classic SPL tokens do not have a metadata update authority");
    if (!live.metadataUpdateAuthority) throw new Error("The metadata update authority has been revoked");
    signer = await getManagedSigner(live.metadataUpdateAuthority);
    if (request.newAuthority !== null) await getManagedSigner(request.newAuthority);
    instructions.push(getUpdateTokenMetadataUpdateAuthorityInstruction({
      metadata: mint,
      updateAuthority: signer,
      newUpdateAuthority: request.newAuthority ? address(request.newAuthority) : null,
    }));
  } else {
    throw new Error("Unsupported token management action");
  }

  const signature = await submitTokenInstructions(rpcUrl, request.transactionVersion, signer!, instructions);
  const nextStored = registryUpdates
    ? await updateTokenMint(request.network, request.mint, registryUpdates)
    : stored;
  return { signature, token: (await enrichTokenMints(rpcUrl, [nextStored]))[0]! };
}

function validateMetadataFields(name: string, symbol: string, metadataUri = "", imageUrl = "") {
  const cleanName = name.trim();
  const cleanSymbol = symbol.trim();
  const cleanUri = metadataUri.trim();
  const cleanImage = imageUrl.trim();
  if (cleanName.length < 1 || cleanName.length > 64) throw new Error("Name must contain 1 to 64 characters");
  if (cleanSymbol.length < 1 || cleanSymbol.length > 12) throw new Error("Symbol must contain 1 to 12 characters");
  if (cleanUri.length > 500 || cleanImage.length > 500) throw new Error("Metadata URLs must be 500 characters or fewer");
  return { name: cleanName, symbol: cleanSymbol, metadataUri: cleanUri, imageUrl: cleanImage };
}

export async function submitTokenInstructions(
  rpcUrl: string,
  version: 0 | 1,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<string> {
  const latest = await rpcCall<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight) };
  const provisional = buildUnsignedTokenMintTransaction(version, feePayer, lifetime, instructions, {
    computeUnitLimit: V1_MAX_COMPUTE_UNIT_LIMIT,
    loadedAccountsDataSizeLimit: V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  });
  const estimate = await simulateTransaction(rpcUrl, provisional);
  const finalTransaction = buildUnsignedTokenMintTransaction(version, feePayer, lifetime, instructions, {
    computeUnitLimit: Math.min(V1_MAX_COMPUTE_UNIT_LIMIT, Math.max(1_000, Math.ceil(estimate.units * 1.1))),
    loadedAccountsDataSizeLimit: Math.min(V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, Math.max(1, Math.ceil((estimate.loadedAccountsDataSize ?? 1) * 1.1))),
  });
  await simulateTransaction(rpcUrl, finalTransaction);
  const signed = await partiallySignTransactionWithSigners([feePayer], finalTransaction);
  const signature = await sendRpc(rpcUrl, getBase64EncodedWireTransaction(signed), false);
  const status = await waitForConfirmation(rpcUrl, signature, lifetime.lastValidBlockHeight);
  if (status !== "confirmed") throw new Error(`Token transaction ${signature} is still pending; refresh before retrying`);
  return signature;
}

async function enrichTokenMints(rpcUrl: string, stored: StoredTokenMint[]): Promise<TrackedTokenMint[]> {
  if (stored.length === 0) return [];
  try {
    const rpc = createSolanaRpc(rpcUrl);
    const classicIndexes = stored.map((entry, index) => ({ entry, index })).filter(({ entry }) => (entry.tokenProgram ?? "classic") === "classic");
    const token2022Indexes = stored.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.tokenProgram === "token2022");
    const output: TrackedTokenMint[] = stored.map((entry) => ({ ...entry, liveStatus: "unavailable" }));
    const [classicAccounts, token2022Accounts] = await Promise.all([
      classicIndexes.length ? fetchAllMaybeMint(rpc, classicIndexes.map(({ entry }) => address(entry.mint)), { commitment: "confirmed" }) : [],
      token2022Indexes.length ? fetchAllMaybeToken2022Mint(rpc, token2022Indexes.map(({ entry }) => address(entry.mint)), { commitment: "confirmed" }) : [],
    ]);
    classicIndexes.forEach(({ entry, index }, accountIndex) => {
      const account = classicAccounts[accountIndex];
      output[index] = account?.exists ? {
        ...entry,
        liveStatus: "available",
        supplyBaseUnits: account.data.supply.toString(),
        mintAuthority: isSome(account.data.mintAuthority) ? account.data.mintAuthority.value : null,
        freezeAuthority: isSome(account.data.freezeAuthority) ? account.data.freezeAuthority.value : null,
      } : { ...entry, liveStatus: "unavailable", liveError: "Mint account was not found" };
    });
    token2022Indexes.forEach(({ entry, index }, accountIndex) => {
      const account = token2022Accounts[accountIndex];
      if (!account?.exists) {
        output[index] = { ...entry, liveStatus: "unavailable", liveError: "Mint account was not found" };
        return;
      }
      const extensions = isSome(account.data.extensions) ? account.data.extensions.value : [];
      const metadata = extensions.find((item) => item.__kind === "TokenMetadata");
      output[index] = {
        ...entry,
        ...(metadata?.__kind === "TokenMetadata" ? {
          name: metadata.name,
          symbol: metadata.symbol,
          metadataUri: metadata.uri,
          imageUrl: metadata.additionalMetadata.get("image") ?? entry.imageUrl,
          metadataUpdateAuthority: isSome(metadata.updateAuthority) ? metadata.updateAuthority.value : null,
        } : {}),
        liveStatus: "available",
        supplyBaseUnits: account.data.supply.toString(),
        mintAuthority: isSome(account.data.mintAuthority) ? account.data.mintAuthority.value : null,
        freezeAuthority: isSome(account.data.freezeAuthority) ? account.data.freezeAuthority.value : null,
      };
    });
    return output;
  } catch (reason) {
    const liveError = reason instanceof Error ? reason.message : "RPC refresh failed";
    return stored.map((entry) => ({ ...entry, liveStatus: "unavailable", liveError }));
  }
}

export function buildUnsignedTokenMintTransaction(
  version: 0 | 1,
  feePayer: KeyPairSigner,
  lifetime: { blockhash: ReturnType<typeof blockhash>; lastValidBlockHeight: bigint },
  instructions: readonly Instruction[],
  resources: { computeUnitLimit: number; loadedAccountsDataSizeLimit: number },
): Transaction {
  if (version === 1) {
    return compileTransaction(buildV1TransactionMessage({
      feePayer,
      lifetime,
      instructions,
      config: {
        computeUnitLimit: resources.computeUnitLimit,
        loadedAccountsDataSizeLimit: resources.loadedAccountsDataSizeLimit,
        priorityFeeLamports: 0n,
      },
    }));
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayerSigner(feePayer, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    (value) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: resources.computeUnitLimit }),
      ...instructions,
    ], value),
  );
  return compileTransaction(message);
}

async function simulateTransaction(rpcUrl: string, transaction: Transaction): Promise<{ units: number; loadedAccountsDataSize?: number }> {
  assertIsTransactionWithinSizeLimit(transaction);
  const result = await rpcCall<SimulationResult>(rpcUrl, "simulateTransaction", [
    getBase64EncodedWireTransaction(transaction),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (result.value.err) {
    throw new Error(`Mint simulation failed: ${JSON.stringify(result.value.err)}\n${result.value.logs?.join("\n") ?? "no program logs"}`);
  }
  return {
    units: result.value.unitsConsumed ?? 1_000,
    ...(result.value.loadedAccountsDataSize === undefined ? {} : { loadedAccountsDataSize: result.value.loadedAccountsDataSize }),
  };
}
