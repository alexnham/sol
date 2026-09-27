import { useState } from "react";

type GuideDestination = "workbench" | "keygen" | "minting";

interface CommandStep {
  title: string;
  purpose: string;
  command?: string;
  detail?: string;
  optional?: boolean;
  action?: { label: string; destination: GuideDestination };
}

interface GuideSection {
  id: string;
  title: string;
  description: string;
  steps: CommandStep[];
}

const TOKEN_MINT = "Hut2HZe7dRURzrdeKqjN3sVZUz4tV7nZ1CYCAWU9JdVM";

const sections: GuideSection[] = [
  {
    id: "boot",
    title: "Start the workbench",
    description: "Install once, then run the client and local API together.",
    steps: [
      {
        title: "Install dependencies",
        purpose: "Run this from transfer-project after cloning or changing packages.",
        command: "npm install",
      },
      {
        title: "Add the RPC key",
        purpose: "Create src/.env. The value stays server-side and is never sent to Vite.",
        command: "HELIUS_API_KEY=your-key",
        detail: "File: src/.env",
      },
      {
        title: "Run locally",
        purpose: "Starts the API and Vite development server.",
        command: "npm run dev",
      },
    ],
  },
  {
    id: "keys",
    title: "Create and fund keys",
    description: "Generate local signers, choose devnet, then fund only the public address.",
    steps: [
      {
        title: "Generate keypairs",
        purpose: "Creates five Solana CLI-compatible keys in generated-keys/ with owner-only permissions.",
        command: "npm run keygen -- 5",
        action: { label: "Open Keygen", destination: "keygen" },
      },
      {
        title: "Import an existing key",
        purpose: "Paste the base58 private key only at the hidden prompt—never place it in the command itself.",
        command: "npm run import-key",
        optional: true,
      },
      {
        title: "Select devnet",
        purpose: "Points the Solana CLI at the safe test cluster.",
        command: "solana config set --url devnet",
      },
      {
        title: "Fund and verify",
        purpose: "Replace WALLET_ADDRESS with one of the public addresses printed by keygen.",
        command: "solana airdrop 2 WALLET_ADDRESS\nsolana balance WALLET_ADDRESS",
      },
    ],
  },
  {
    id: "token-2022",
    title: "Create a Token-2022 mint",
    description: "Use this route when the mint itself needs a metadata extension and URI.",
    steps: [
      {
        title: "Create the mint with metadata enabled",
        purpose: "Save the mint address printed by this command; it replaces MINT_ADDRESS below.",
        command: "spl-token --program-2022 create-token \\\n  --decimals 9 \\\n  --enable-metadata",
      },
      {
        title: "Create the token account",
        purpose: "Creates the current wallet's associated account for the new mint.",
        command: "spl-token --program-2022 create-account MINT_ADDRESS",
      },
      {
        title: "Publish metadata.json",
        purpose: "Host this JSON at a stable public URL. The image URL belongs inside it.",
        command: "{\n  \"name\": \"Alex Token\",\n  \"symbol\": \"ALEX\",\n  \"description\": \"Alex's test token\",\n  \"image\": \"https://your-host.com/token.png\"\n}",
      },
      {
        title: "Initialize metadata once",
        purpose: "The URI should return JSON, not the image bytes directly.",
        command: "spl-token --program-2022 initialize-metadata \\\n  MINT_ADDRESS \\\n  \"Alex Token\" \\\n  \"ALEX\" \\\n  \"https://your-host.com/metadata.json\"",
      },
      {
        title: "Mint a supply",
        purpose: "This example mints 1,000 display tokens to the current wallet.",
        command: "spl-token --program-2022 mint MINT_ADDRESS 1000",
      },
      {
        title: "Inspect the result",
        purpose: "Display reads the mint and metadata; accounts lists token holdings.",
        command: "spl-token --program-2022 display MINT_ADDRESS\nspl-token --program-2022 accounts",
      },
      {
        title: "Inspect the example mint",
        purpose: "Runs display against the Token-2022 mint linked in the reference history.",
        command: `spl-token --program-2022 display ${TOKEN_MINT}`,
        optional: true,
      },
      {
        title: "Update existing metadata",
        purpose: "Use this instead of initialize-metadata when the extension already exists.",
        command: "spl-token --program-2022 update-metadata \\\n  MINT_ADDRESS \\\n  uri \\\n  \"https://your-host.com/metadata.json\"",
        optional: true,
      },
    ],
  },
  {
    id: "classic-token",
    title: "Create a classic SPL token",
    description: "The workbench route creates the mint, ATA, initial supply, and authority changes atomically.",
    steps: [
      {
        title: "Create from the interface",
        purpose: "Choose a managed authority, supply, decimals, and optional revocations in Minting.",
        action: { label: "Open Minting", destination: "minting" },
      },
      {
        title: "Run the devnet smoke path",
        purpose: "The authority must already exist in Keygen and hold devnet SOL.",
        command: "RUN_DEVNET_SMOKE=1 \\\nSMOKE_TOKEN_MINT_AUTHORITY=YOUR_MANAGED_ADDRESS \\\nnpm run smoke:token-mint",
        optional: true,
      },
    ],
  },
  {
    id: "transactions",
    title: "Measure and send transactions",
    description: "Measure first without signing, then use a funded devnet key for the signed smoke test.",
    steps: [
      {
        title: "Measure v1 capacity",
        purpose: "Builds and simulates transaction shapes without signing or submitting them.",
        command: "npm run measure:v1 -- SOURCE_ADDRESS devnet",
      },
      {
        title: "Send the v1 devnet smoke transaction",
        purpose: "The file must be a Solana CLI-compatible JSON array containing 64 bytes.",
        command: "npm run smoke:v1 -- /path/to/devnet-keypair.json",
        optional: true,
      },
      {
        title: "Build transfers visually",
        purpose: "Use share, consolidation, or ALT templates, prepare a quote, then sign and send.",
        action: { label: "Open Workbench", destination: "workbench" },
      },
    ],
  },
  {
    id: "checks",
    title: "Verify before you stop",
    description: "These checks do not submit transactions or touch mainnet.",
    steps: [
      {
        title: "Run the test suite",
        purpose: "Checks transaction construction, schemas, plugins, ALTs, and token mint behavior.",
        command: "npm test",
      },
      {
        title: "Check types and production build",
        purpose: "Run both after changing client or server code.",
        command: "npm run typecheck\nnpm run build",
      },
    ],
  },
];

export function GuideTab({ onNavigate }: { onNavigate(destination: GuideDestination): void }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copyCommand(id: string, command: string) {
    await navigator.clipboard.writeText(command);
    setCopied(id);
    window.setTimeout(() => setCopied((current) => current === id ? null : current), 1600);
  }

  return (
    <section className="guide-workspace" aria-labelledby="guide-title">
      <header className="guide-hero">
        <div>
          <span className="guide-kicker">CLI how-to library</span>
          <h2 id="guide-title">How to work with tokens from the command line.</h2>
          <p>Pick the task you need. Commands run from <code>transfer-project</code>, and each recipe keeps its own steps in the right order.</p>
        </div>
        <div className="guide-safety"><strong>Start on devnet</strong><span>Mainnet spends real SOL and cannot be undone.</span></div>
      </header>

      <div className="guide-layout">
        <aside className="guide-index" aria-label="Guide sections">
          <strong>How-to topics</strong>
          <ol>
            {sections.map((section) => (
              <li key={section.id}><a href={`#guide-${section.id}`}>{section.title}</a></li>
            ))}
          </ol>
          <div className="guide-variable-note">
            <span>Example mint</span>
            <code>{TOKEN_MINT}</code>
            <a href={`https://orbmarkets.io/address/${TOKEN_MINT}/history`} target="_blank" rel="noreferrer">View its history on Orb</a>
          </div>
        </aside>

        <div className="guide-runbook">
          {sections.map((section) => (
            <section className="guide-section" id={`guide-${section.id}`} key={section.id}>
              <header>
                <span>How to</span>
                <div><h3>{section.title}</h3><p>{section.description}</p></div>
              </header>
              <div className="guide-steps">
                {section.steps.map((step, stepIndex) => {
                  const commandId = `${section.id}-${stepIndex}`;
                  return (
                    <article className="guide-step" key={commandId}>
                      <div className="guide-step-copy">
                        <div className="guide-step-title">
                          <h4>{step.title}</h4>
                          {step.optional && <span>Optional</span>}
                        </div>
                        <p>{step.purpose}</p>
                        {step.detail && <small>{step.detail}</small>}
                      </div>
                      {step.command && (
                        <div className="guide-command">
                          <pre><code>{step.command}</code></pre>
                          <button type="button" onClick={() => void copyCommand(commandId, step.command!)} aria-label={`Copy ${step.title} command`}>
                            {copied === commandId ? "Copied" : "Copy"}
                          </button>
                        </div>
                      )}
                      {step.action && (
                        <button className="secondary guide-action" type="button" onClick={() => onNavigate(step.action!.destination)}>{step.action.label}</button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
