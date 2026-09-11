"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useMemo, type ReactNode } from "react";
import type { Address } from "viem";
import { CHAIN_ID } from "@/lib/config";
import { SponsorCtx, type Sponsor } from "@/lib/sponsor";
import { PRIVY_APP_ID, PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { Spinner } from "./ui";

/** Header "Sign in" for a build with no Privy app id: shown, but it can't open anything. */
export function SignInDisabledButton() {
  return (
    <button className="btn btn-sm" disabled title="Sign-in isn't set up for this deployment">
      Sign in
    </button>
  );
}

/** Shown where an action needs a wallet and nobody is logged in (Privy mode). Disabled without a Privy app id. */
export function PrivyLoginPrompt({ why }: { why?: string }) {
  return PRIVY_APP_ID ? <LivePrivyLoginPrompt why={why} /> : <LoginPromptBody why={why} ready={false} authenticated={false} />;
}

function LivePrivyLoginPrompt({ why }: { why?: string }) {
  const { ready, authenticated, login } = usePrivy();
  return <LoginPromptBody why={why} ready={ready} authenticated={authenticated} onLogin={() => login()} />;
}

function LoginPromptBody({ why, ready, authenticated, onLogin }: { why?: string; ready: boolean; authenticated: boolean; onLogin?: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">{why ?? "Sign in to continue."}</p>
      {authenticated ? (
        <p className="flex items-center gap-2 text-muted" aria-live="polite">
          <Spinner className="h-3.5 w-3.5" /> Setting up your account…
        </p>
      ) : (
        <button className="btn btn-primary w-full" disabled={!ready || !onLogin} onClick={onLogin}>
          Sign in
        </button>
      )}
      <p className="text-xs leading-relaxed text-muted">
        Use your email or a wallet you already have. Signing in with email creates a wallet for you{PRIVY_SPONSOR_GAS ? " and covers its network fees" : ""}; you can export its key later.
      </p>
    </div>
  );
}

/**
 * Gives useTx a sponsored sender for the user's Privy embedded wallet (EIP-7702 + paymaster run by
 * Privy; "App pays" must be enabled for the chain in the Privy dashboard). External wallets are
 * never sponsored: they pay their own gas through wagmi.
 */
export function PrivySponsorBridge({ children }: { children: ReactNode }) {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const value = useMemo<Sponsor | null>(() => {
    if (!PRIVY_SPONSOR_GAS) return null;
    return {
      canSponsor: (from: Address) => wallets.some((w) => w.walletClientType === "privy" && w.address.toLowerCase() === from.toLowerCase()),
      send: async (tx, from) => (await sendTransaction({ to: tx.to, data: tx.data, chainId: CHAIN_ID }, { sponsor: true, address: from })).hash,
    };
  }, [wallets, sendTransaction]);
  return <SponsorCtx.Provider value={value}>{children}</SponsorCtx.Provider>;
}
