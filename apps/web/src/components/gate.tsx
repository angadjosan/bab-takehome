"use client";

import type { ReactNode } from "react";
import { CHAIN_ID, CHAIN_NAME, deployment, TEE_URL } from "@/lib/config";
import { HAS_MARKET_ABI } from "@/lib/abi";
import { Empty, Notice } from "./ui";

export function NotDeployed() {
  return (
    <Empty title={`The market isn’t deployed on ${CHAIN_NAME} yet`}>
      <p>
        This app shows only live on-chain data, and there is no deployment for chain {CHAIN_ID} in <code className="font-mono text-xs text-ink">deployments/</code>.
      </p>
      <p className="mt-2">
        Operators: deploy the contracts, run <code className="font-mono text-xs text-ink">scripts/sync-web.sh</code> from the repository root, and rebuild. To use a local Anvil node, set{" "}
        <code className="font-mono text-xs text-ink">NEXT_PUBLIC_CHAIN_ID=31337</code>.
      </p>
      {!HAS_MARKET_ABI && <p className="mt-2 text-xs text-faint">No compiled contract ABI has been synced into the web app either.</p>}
    </Empty>
  );
}

export function DeploymentGate({ children }: { children: ReactNode }) {
  if (!deployment) return <NotDeployed />;
  return <>{children}</>;
}

export function TeeMissingNotice() {
  if (TEE_URL) return null;
  return (
    <Notice tone="warn" title="Previews can’t load">
      Set <code className="font-mono text-xs">NEXT_PUBLIC_TEE_URL</code> so the app can fetch signed previews and deliveries. Listings and purchases still load from the chain.
    </Notice>
  );
}
