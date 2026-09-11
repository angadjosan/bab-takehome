"use client";

import type { ReactNode } from "react";
import { CHAIN_ID, CHAIN_NAME, deployment, TEE_URL } from "@/lib/config";
import { HAS_MARKET_ABI } from "@/lib/abi";
import { Notice } from "./ui";

export function NotDeployed() {
  return (
    <div className="card card-pad">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-lg bg-warn-soft text-center text-lg leading-9 text-warn">!</div>
        <div className="space-y-2 text-sm">
          <h2 className="text-base font-semibold">The market is not deployed on {CHAIN_NAME} yet</h2>
          <p className="text-muted">
            This app only shows real on-chain state. There is no deployment file for chain {CHAIN_ID} in <code className="font-mono text-xs">deployments/</code>, so
            there is nothing to display yet. Nothing on this site is simulated.
          </p>
          <p className="text-muted">
            Operators: deploy the contracts, then run <code className="font-mono text-xs">scripts/sync-web.sh</code> from the repository root to copy the ABI and addresses into the web app,
            and rebuild. To point at a local Anvil node instead, set <code className="font-mono text-xs">NEXT_PUBLIC_CHAIN_ID=31337</code>.
          </p>
          {!HAS_MARKET_ABI && <p className="text-xs text-faint">No compiled contract ABI has been synced into the web app yet either.</p>}
        </div>
      </div>
    </div>
  );
}

export function DeploymentGate({ children }: { children: ReactNode }) {
  if (!deployment) return <NotDeployed />;
  return <>{children}</>;
}

export function TeeMissingNotice() {
  if (TEE_URL) return null;
  return (
    <Notice tone="warn" title="TEE service URL not configured">
      Set <code className="font-mono">NEXT_PUBLIC_TEE_URL</code> to load signed preview reports, attestation, and deliveries. On-chain data still loads.
    </Notice>
  );
}
