# Solana Split and Consolidation Workbench

An internal, localhost-only workbench for building one version-0 Solana transaction that either:

- shares SOL from one sender to many receivers; or
- consolidates SOL from many senders into one receiver using partial signatures over the same immutable message.

The UI never accepts private keys. A caller must inject a `SignerProvider` before signing is enabled.

## Run locally

```bash
npm install
npm run dev
```

The API binds to `127.0.0.1:8787`. Vite normally uses `127.0.0.1:5173` and selects the next free port when needed. Put `HELIUS_API_KEY` in `src/.env`; Vite never receives it.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

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

The UI also includes a **Keygen** tab. It lists public metadata from compatible files in `generated-keys/`, generates up to 1,000 wallets per request, and can place selected wallets into the workbench as sources or destinations. Selecting multiple sources creates a consolidation plan; selecting destinations creates a share plan with editable `0.01 SOL` defaults.

Private-key bytes never enter the browser. Managed signing happens through the localhost API, which signs only a transaction whose message exactly matches an active server-side preparation and only for an address that preparation requires. External `SignerProvider` adapters can still supply any signers not present in the local vault.

## Run with Docker

The production container builds the Vite client and serves both the UI and API from port `8787`. Secrets are supplied only at runtime and are excluded from the image build context.

```bash
docker build -t solana-workbench .
docker run --rm \
  --name solana-workbench \
  -p 127.0.0.1:8787:8787 \
  -e HELIUS_API_KEY=your-key \
  solana-workbench
```

Open `http://127.0.0.1:8787`. The image runs as the unprivileged `node` user and includes a `/api/health` container health check.

For Compose, export the secret in your shell and start the service:

```bash
export HELIUS_API_KEY=your-key
docker compose up --build
```

Compose publishes only to the host loopback interface. Do not commit a real `.env` file or bake an API key into the image.

## JSON plans

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

`recievers` is accepted as an alias and normalized. `feePayer` and `plugin` are optional. Amounts are exact decimal strings with at most nine decimal places.

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

A `DeliveryAdapter` changes quoting/submission transport. Register one server-side with `registerDeliveryAdapter`; the built-in visible routes remain Economy, Fast, and Sender Max. All adapters and transfer plugins must retain the one-transaction invariant.

## Delivery packages

Each built-in delivery experiment is an independent npm workspace package:

- `packages/delivery-economy` — normal RPC, preflight, no priority fee or tip.
- `packages/delivery-fast` — Helius Sender with `swqos_only=true`, capped priority fee, and Fast tip.
- `packages/delivery-max` — full Helius Sender path, capped priority fee, and Sender Max tip.
- `packages/delivery-sdk` — shared adapter contracts, quoting math, RPC transport, and confirmation polling.

`src/server/delivery.ts` only imports and registers the packages. To experiment with a route, edit its package without changing preparation, signing, or the other delivery routes. Keep its exported adapter ID stable if you want the existing UI selection to continue working.

## Safety behavior

- Devnet enables Economy only. Fast and Sender Max remain visible but disabled.
- Mainnet always requires a final confirmation screen.
- Oversized transactions are rejected and are never silently split.
- Duplicate addresses, self-transfers, invalid addresses, invalid amounts, and insufficient balances are rejected.
- The server checks that the submitted signed message exactly matches the prepared message and has not expired.
- Automated tests never submit Mainnet transfers.
