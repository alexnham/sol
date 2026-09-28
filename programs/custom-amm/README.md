# Custom AMM program

Experimental constant-product AMM for the local Solana workbench. It supports classic SPL Token
and metadata-only Token-2022 mints through separate token-program accounts. It is not audited and
must not be used with valuable mainnet funds.

Program ID: `HwtbuEdcs3i8Y1pugfH8MTvzxvqwUUYNjE96QW5NFy3j`

```bash
cd programs/custom-amm
cargo build-sbf
solana config set --url devnet
solana program deploy target/deploy/custom_amm.so \
  --program-id target/deploy/custom_amm-keypair.json
```

The deployment keypair under `target/` is intentionally ignored by Git. Back it up if the deployed
address must remain upgradeable.
