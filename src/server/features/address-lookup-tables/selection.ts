import {
  address,
  createSolanaRpc,
  fetchAddressesForLookupTables,
  type AddressesByLookupTableAddress,
} from "@solana/kit";
import type { LookupTableSharePlanInput, SharePlan } from "../../../shared/contracts";
import { parseTransferPlan } from "../../../shared/schema";

export async function resolveLookupTableReceivers(
  rpcUrl: string,
  input: LookupTableSharePlanInput,
): Promise<SharePlan> {
  const requestedTables = [...new Set(
    input.receiversFromLookupTables.map((selection) => selection.address),
  )];
  const lookupTables = await fetchLookupTables(rpcUrl, requestedTables);
  return expandLookupTableReceivers(input, lookupTables);
}

export function expandLookupTableReceivers(
  input: LookupTableSharePlanInput,
  lookupTables: Readonly<Record<string, readonly string[]>>,
): SharePlan {
  const selectedReceivers = input.receiversFromLookupTables.flatMap((selection) => {
    const table = lookupTables[selection.address];
    if (!table) throw new Error(`Address lookup table ${selection.address} was not found`);

    const indexes = new Set(selection.indexes ?? []);
    for (const range of selection.ranges ?? []) {
      for (let index = range.start; index <= range.end; index += 1) indexes.add(index);
    }

    return [...indexes]
      .sort((left, right) => left - right)
      .map((index) => {
        const selectedAddress = table[index];
        if (!selectedAddress) {
          throw new Error(
            `ALT ${selection.address} index ${index} is out of bounds (table has ${table.length} addresses)`,
          );
        }
        return { address: selectedAddress, amountSol: selection.amountSol };
      });
  });

  const rawPlan = {
    type: "share" as const,
    senders: input.senders,
    receivers: [...input.receivers, ...selectedReceivers],
    ...(input.feePayer ? { feePayer: input.feePayer } : {}),
    ...(input.plugin ? { plugin: input.plugin } : {}),
    addressLookupTables: [...new Set([
      ...(input.addressLookupTables ?? []),
      ...input.receiversFromLookupTables.map((selection) => selection.address),
    ])],
  };
  return parseTransferPlan(rawPlan).plan as SharePlan;
}

async function fetchLookupTables(
  rpcUrl: string,
  lookupTableAddresses: readonly string[],
): Promise<Record<string, string[]>> {
  const rpc = createSolanaRpc(rpcUrl);
  let fetched: AddressesByLookupTableAddress;
  try {
    fetched = await fetchAddressesForLookupTables(
      lookupTableAddresses.map((value) => address(value)),
      rpc,
      { commitment: "confirmed" },
    );
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "lookup table fetch failed";
    throw new Error(`Could not load receiver address lookup tables: ${message}`);
  }
  return Object.fromEntries(
    Object.entries(fetched).map(([tableAddress, addresses]) => [
      tableAddress,
      addresses.map(String),
    ]),
  );
}

/**
 * Fetches existing on-chain ALTs and keeps only tables that save space for this transaction.
 * The exact loaded-account/runtime boundary is enforced by candidate simulation.
 */
export async function fetchUsefulLookupTables(
  rpcUrl: string,
  lookupTableAddresses: readonly string[],
  candidateAddresses: readonly string[],
): Promise<Record<string, string[]>> {
  const uniqueTableAddresses = [...new Set(lookupTableAddresses)];
  if (uniqueTableAddresses.length === 0) return {};

  const rpc = createSolanaRpc(rpcUrl);
  let fetched: AddressesByLookupTableAddress;
  try {
    fetched = await fetchAddressesForLookupTables(
      uniqueTableAddresses.map((value) => address(value)),
      rpc,
      { commitment: "confirmed" },
    );
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "lookup table fetch failed";
    throw new Error(`Could not load the requested address lookup tables: ${message}`);
  }

  return selectUsefulLookupTables(
    Object.fromEntries(
      Object.entries(fetched).map(([tableAddress, addresses]) => [
        tableAddress,
        addresses.map(String),
      ]),
    ),
    candidateAddresses,
  );
}

export function selectUsefulLookupTables(
  lookupTables: Readonly<Record<string, readonly string[]>>,
  candidateAddresses: readonly string[],
): Record<string, string[]> {
  const uncovered = new Set(candidateAddresses);
  const remaining = Object.entries(lookupTables);
  const selected: Record<string, string[]> = {};

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestCoverage: string[] = [];

    for (let index = 0; index < remaining.length; index += 1) {
      const covered = remaining[index]![1].filter((value) => uncovered.has(value));
      if (covered.length > bestCoverage.length) {
        bestIndex = index;
        bestCoverage = covered;
      }
    }

    // A lookup-table reference has a fixed address/header cost. Looking up one key is larger
    // than leaving that key inline; two or more keys produces an actual byte saving.
    if (bestIndex < 0 || bestCoverage.length < 2) break;
    const [tableAddress, addresses] = remaining.splice(bestIndex, 1)[0]!;
    selected[tableAddress] = [...addresses];
    for (const covered of bestCoverage) uncovered.delete(covered);
  }

  return selected;
}
