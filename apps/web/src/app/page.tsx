"use client";

import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { EnvBrowser } from "@/components/env-browser";

export default function Home() {
  return (
    <DeploymentGate>
      <div className="space-y-4">
        <TeeMissingNotice />
        <EnvBrowser />
      </div>
    </DeploymentGate>
  );
}
