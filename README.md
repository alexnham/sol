# Solana Split and Consolidation Workbench

An internal, localhost-only workbench for building selectable version-0 or version-1 Solana
transactions that either:

- shares SOL from one sender to many receivers through a v0 distributor or v1 System transfers; or
- consolidates SOL from many senders into one receiver using partial signatures over the same immutable message.

The UI never accepts private keys. A caller must inject a `SignerProvider` before signing is enabled.

## Run locally

```bash
npm install
npm run dev
```

The API binds to `127.0.0.1:8787`. Vite normally uses `127.0.0.1:5173` and selects the next free port when needed. Put the RPC key and deployed distributor ID in `src/.env`; Vite never receives them:

```dotenv
HELIUS_API_KEY=your-key
# Optional override; delivery-custom defaults to 7wRVHVQwGKkrQ4DA4auS5BtwkCgcQuSwcPtTpzFBu3bf
DISTRIBUTOR_PROGRAM_ID_DEVNET=your-devnet-program-id
# DISTRIBUTOR_PROGRAM_ID_MAINNET=your-reviewed-mainnet-program-id
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

The header selects the transaction format independently from the delivery route. v0 keeps the
1,232-byte message, Compute Budget instructions, and optional ALT compression. v1 uses the
4,096-byte format, stores resource limits in transaction config, and includes every address
directly because v1 does not support ALTs.

## Generate local keypairs

Generate any number of Solana keypairs with:

```bash
npm run keygen -- 5
```

The command writes one timestamped `.txt` file under `generated-keys/`. The file contains public addresses and Solana CLI-compatible 64-byte secret-key arrays. The directory is excluded from Git and Docker, uses owner-only directory permissions, and each output file is created with mode `0600`.

The secret keys are stored as plaintext because this utility is intended for local development. Never commit, share, or fund these files with assets you cannot afford to lose; use a hardware wallet or managed signer for production funds.

To import a wallet-exported, base58-encoded 64-byte private key, use the hidden CLI prompt:

```bash
npm run import-key
```

The command derives the public address for confirmation and writes a new owner-readable vault file. Do not pass the private key as a command-line argument. For non-interactive input, pipe the key and add `--yes` only after independently verifying the derived address.

The UI also includes a **Keygen** tab. It lists public metadata from compatible files in `generated-keys/`, generates up to 1,000 wallets per request, and can place selected wallets into the workbench as sources or destinations. Selecting multiple sources creates a consolidation plan; selecting destinations creates a share plan with editable `0.01 SOL` defaults. It can also create an address lookup table from 2–256 selected managed wallets and add the new table address to the transfer JSON.

Private-key bytes never enter the browser. Managed signing happens through the localhost API, which signs only a transaction whose message exactly matches an active server-side preparation and only for an address that preparation requires. External `SignerProvider` adapters can still supply any signers not present in the local vault.

## Run with Docker

The production container builds the Vite client and serves both the UI and API from port `8787`. Secrets are supplied only at runtime and are excluded from the image build context.

```bash
docker build -t solana-workbench .
docker run --rm \
  --name solana-workbench \
  -p 127.0.0.1:8787:8787 \
  -e HELIUS_API_KEY=your-key \
  -e DISTRIBUTOR_PROGRAM_ID_DEVNET=your-devnet-program-id \
  solana-workbench
```

Open `http://127.0.0.1:8787`. The image runs as the unprivileged `node` user and includes a `/api/health` container health check.

For Compose, export the secret in your shell and start the service:

```bash
export HELIUS_API_KEY=your-key
export DISTRIBUTOR_PROGRAM_ID_DEVNET=your-devnet-program-id
docker compose up --build
```

Compose publishes only to the host loopback interface. Do not commit a real `.env` file or bake an API key into the image.

## JSON plans

Use the **Demo template** picker above the JSON editor to load a valid share or consolidation
example. The same copy-ready plans are available in `examples/share.json` and
`examples/consolidation.json`. ALT examples are available in
`examples/share-alt-explicit.json` and `examples/share-alt-selection.json`. Replace the public
addresses and lookup-table address with accounts you control before preparing or submitting a
transaction.

Share:

```json
{
  "type": "share",
  "senders": [{ "address": "SOURCE_ADDRESS" }],
  "receivers": [
    { "address": "DESTINATION_1", "amountSol": "0.10" },
    { "address": "DESTINATION_2", "amountSol": "0.25" }
  ]
}
```

Consolidation:

```json
{
  "type": "consolidation",
  "senders": [
    { "address": "SOURCE_1", "amountSol": "0.10" },
    { "address": "SOURCE_2", "amountSol": "0.25" }
  ],
  "receivers": [{ "address": "DESTINATION_ADDRESS" }]
}
```

`recievers` is accepted as an alias and normalized. `feePayer`, `plugin`, and
`addressLookupTables` are optional. Amounts are exact decimal strings with at most nine decimal
places.

### Transaction shape and batching

For a v0 share plan, the built-in `native-sol-transfer` plugin emits one distributor instruction
per batch. Its writable accounts are the source signer followed by the recipients, with the System
Program readonly account last. Instruction data contains consecutive little-endian `u64` lamport
amounts, so recipient addresses appear only in the v0 account list and can be loaded from an ALT.

For v1, the same plugin emits one System Program transfer instruction per recipient. The
transaction contains no distributor call, ALT lookup, or Compute Budget instruction. Its
`computeUnitLimit`, `loadedAccountsDataSizeLimit`, and total `priorityFeeLamports` are encoded in
the v1 transaction config.

The server does not hard-code a recipient count. It binary-searches candidate prefixes, compiles
the exact selected-format transaction, including the delivery tip and signer slots. v0 includes
Compute Budget instructions and useful ALTs; v1 includes its resource config and static addresses.
Each candidate must compile, fit its 1,232- or 4,096-byte limit, and simulate successfully. v1
simulation must also return loaded-account data usage. Final resource limits add 10%, respect the
runtime caps, and the final v1 wire transaction is simulated again. Prepared batches are signed
and submitted in order through the existing RPC or Helius Sender adapter. Each batch is atomic;
separate batches are separate transactions.

Build and deploy the program using
`program-examples/basics/transfer-sol-modified/native/README.md`, set the matching Program ID
environment variable above, restart the server, and use an active ALT containing the recipients.

### Address lookup tables

To compress recipient addresses into an existing on-chain address lookup table (ALT), add its
address to the plan:

```json
{
  "type": "share",
  "senders": [{ "address": "SOURCE_ADDRESS" }],
  "receivers": [
    { "address": "DESTINATION_1", "amountSol": "0.10" },
    { "address": "DESTINATION_2", "amountSol": "0.25" }
  ],
  "addressLookupTables": ["LOOKUP_TABLE_ACCOUNT_ADDRESS"]
}
```

For v0, the server fetches the tables through the configured Helius RPC, chooses the smallest useful set,
and returns their ordered contents in the preparation so the browser compiles the identical v0
message. For v1, ALT recipient selectors are resolved first, but the resulting addresses are
included as static account keys rather than lookup references. A table is skipped in v0 when it matches fewer than two otherwise-inline accounts because its
fixed reference overhead would make the transaction larger.

The ALT can also supply share recipients by zero-based index or inclusive index range:

```json
{
  "type": "share",
  "senders": [{ "address": "SOURCE_ADDRESS" }],
  "receivers": [],
  "receiversFromLookupTables": [
    {
      "address": "LOOKUP_TABLE_ACCOUNT_ADDRESS",
      "amountSol": "0.00001",
      "indexes": [0, 4, 9],
      "ranges": [{ "start": 20, "end": 29 }]
    }
  ]
}
```

`indexes` and `ranges` may be combined. Overlapping positions within one selector are deduplicated,
then expanded in ascending index order. The server rejects indexes outside the table and duplicate
wallets across selectors. Referenced tables are automatically added to `addressLookupTables`.
The expanded transaction must still fit the 1,232-byte wire limit and pass selected-cluster
simulation, including that cluster's loaded-account and instruction-trace limits.

To create a table in the UI:

1. Open **Keygen** and select 2–256 managed wallets.
2. Choose a managed wallet as the ALT authority and fee payer. It must have enough SOL on the
   selected network to pay rent and transaction fees.
3. Select **Create ALT**. The server creates the table and adds the first 30 addresses atomically,
   extends it in additional batches of 30, confirms every transaction, and waits for the entries
   to become active.
4. Select **Add ALT to transfer JSON** to use it in the current plan.

Created tables are saved to `generated-keys/address-lookup-tables.json` and displayed in a separate
**Address lookup tables** section in Keygen. This registry contains public metadata and table
entries only—never secret keys. To save a table created elsewhere, select its network, paste its
account address into **Save existing ALT**, and the server will verify and load it from the RPC
before recording it. Tables from both networks remain visible, while the add-to-JSON action is
enabled only for the currently selected network.

Creation submits `ceil(address count / 30)` setup transactions because the create instruction and
first extension share one transaction.
Creating tables on mainnet requires an extra browser confirmation. A selection larger than 256
must be split across separate table creations.

Each ALT must contain the intended recipients and be active before preparing the transfer. A table
can store 256 addresses, while each candidate transaction must still fit in 1,232 bytes and pass
cluster simulation. Signers cannot be loaded from an ALT. For native SOL sharing, use one
table containing all recipient addresses when possible; supplying more tables only helps when the
addresses are already spread across them.

References: [Helius Solana programming model](https://www.helius.dev/blog/the-solana-programming-model-an-introduction-to-developing-on-solana) and the [Solana ALT guide](https://solana.com/developers/cookbook/transactions/lookup-tables).

## Attach signing

Implement the interface in `src/shared/contracts.ts` and attach it at app startup:

```ts
window.solanaWorkbench?.setSignerProvider({
  id: "my-wallet-provider",
  async getSigner(address) {
    // Resolve this address through a wallet, HSM, or another secure adapter.
    // Return a TransactionPartialSigner; never return or expose private-key text.
    return resolveSigner(address);
  },
});
```

For consolidation, the workbench resolves every required signer, asks each signer to sign the same compiled message, verifies that the message bytes did not change, and submits the fully signed transaction once. Any blockhash expiry requires a fresh preparation and fresh signatures.

The review pane lists every required wallet with `Waiting`, `Signing`, `Signed`, or `Failed` status. Partial signatures are merged sequentially into the same transaction, so the operator can see exactly which wallet is still missing without creating additional transactions.

## Add a transfer plugin

A `TransferPlugin` controls validation, required signers, and the instructions included in the single transaction. Register the same plugin module in both browser and server entry points because each side independently reconstructs and verifies the transaction.

```ts
import { registerTransferPlugin } from "./shared/plugin-registry";
import type { TransferPlugin } from "./shared/contracts";

export const customTransfer: TransferPlugin = {
  id: "custom-transfer",
  label: "Custom transfer",
  supports: (_plan, _network) => true,
  validate: (_context) => ({ ok: true, errors: [] }),
  requiredSigners: (_context) => [],
  async buildInstructions(context) {
    return buildCustomInstructions(context);
  },
};

registerTransferPlugin(customTransfer);
```

Import that registration module from `src/client/main.tsx` and `src/server/index.ts`. It will then appear in the UI transfer-strategy selector. A JSON plan can pin it with `"plugin": "custom-transfer"`.

A `DeliveryAdapter` changes quoting/submission transport. Register one server-side with `registerDeliveryAdapter`; the built-in visible routes remain Economy, Fast, and Sender Max. Each prepared batch still contains exactly one transaction.

## Delivery packages

Each built-in delivery experiment is an independent npm workspace package:

- `packages/delivery-economy` — normal RPC, preflight, no priority fee or tip.
- `packages/delivery-custom` — the deployed devnet distributor ID, raw instruction builder, and normal-RPC custom route.
- `packages/delivery-fast` — Helius Sender with `swqos_only=true`, capped priority fee, and Fast tip.
- `packages/delivery-max` — full Helius Sender path, capped priority fee, and Sender Max tip.
- `packages/delivery-sdk` — shared adapter contracts, quoting math, RPC transport, and confirmation polling.
- `packages/transaction-v1` — pure v1 message construction, validation, limits, and resource estimation.

Measure the actual v1 share capacity against the configured RPC without signing or submitting:

```bash
npm run measure:v1 -- SOURCE_ADDRESS devnet
```

The source must exist and hold enough SOL for simulation. The command reports the measured
Economy/Custom, Fast, and Max shapes separately; it does not hard-code a recipient count.

An opt-in signed devnet smoke test accepts a Solana CLI-compatible keypair file:

```bash
npm run smoke:v1 -- /path/to/devnet-keypair.json
```

`src/server/delivery.ts` only imports and registers the packages. To experiment with a route, edit its package without changing preparation, signing, or the other delivery routes. Keep its exported adapter ID stable if you want the existing UI selection to continue working.

## Safety behavior

- Devnet enables Economy and Custom. Fast and Sender Max remain visible but disabled.
- Mainnet always requires a final confirmation screen.
- Oversized transactions are rejected and are never silently split.
- Duplicate addresses, self-transfers, invalid addresses, invalid amounts, and insufficient balances are rejected.
- The server checks that the submitted signed message exactly matches the prepared message and has not expired.
- Automated tests never submit Mainnet transfers.
