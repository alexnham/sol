# Source layout

The application is organized by runtime first, then by feature.

```text
src/
├── client/
│   ├── features/          # Feature-owned React UI and presentation helpers
│   │   ├── airship/
│   │   ├── guide/
│   │   ├── liquidity/
│   │   └── minting/
│   ├── App.tsx            # Application shell and cross-feature navigation
│   ├── api.ts             # Browser-to-server transport
│   └── signer-provider.ts # Client signing boundary
├── server/
│   ├── features/          # Server-side workflows, grouped by domain
│   │   ├── address-lookup-tables/
│   │   ├── airship/
│   │   ├── liquidity/
│   │   ├── token-mints/
│   │   └── transfers/
│   ├── http/
│   │   ├── app.ts         # Express assembly and common middleware
│   │   └── routes/        # Thin HTTP adapters grouped by feature
│   ├── infrastructure/    # RPC, key storage, and SDK compatibility
│   ├── config.ts          # Environment-backed network configuration
│   └── index.ts           # Minimal process entry point
├── shared/                # Browser/server contracts and pure domain logic
└── test/                  # Cross-layer and integration-focused tests
```

## Boundaries

- A client feature may import shared contracts and the client API, but not server modules.
- A server feature may import shared contracts and server infrastructure, but not client modules.
- `shared` must stay runtime-neutral so it can be loaded by both browser and server code.
- Feature directories expose an `index.ts`; callers should use that public entry point instead of importing feature internals.
- Route modules translate HTTP input/output and delegate to feature services.
- `server/http/app.ts` composes routes and middleware; business logic should not be added there.
- `server/index.ts` only loads configuration and starts the process.

New feature-specific files should be placed beside the feature that owns them. Move code into shared or infrastructure modules only after a second feature genuinely needs it.
