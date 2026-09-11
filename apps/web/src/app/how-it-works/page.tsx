"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTokenInfo } from "@/components/providers";
import { AddressLink, Card } from "@/components/ui";
import { CHAIN_ID, CHAIN_NAME, IS_MAINNET, deployment, TEE_URL } from "@/lib/config";
import { useAttestation, useHealth } from "@/lib/docs";
import { fmtUsdc, fmtWindow, pct } from "@/lib/format";
import { useMarketParams } from "@/lib/market";

export default function HowItWorks() {
  const token = useTokenInfo();
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <p className="section-title">How it works · trust assumptions</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">What you are trusting when you buy here</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          An RL environment is a practice ground for an AI agent: tasks, tools, and a grader. Showing its tasks and hidden tests gives the product away, so it has to be sold before inspection. This
          market replaces inspection with a signed preview, escrow, a short challenge window with bounded refunds, and purchase-linked reputation. Each of those rests on someone or something you have
          to trust. This page lists them.
        </p>
      </div>

      <Card title="The flow">
        <ol className="space-y-4 text-sm">
          <Flow n={1} t="Seller lists a version">
            Posts hashes of the plaintext bundle, the ciphertext, the image, the description, manifest, and license, plus Merkle roots over salted task commitments (purchased and audit holdout), a price,
            and collateral. The encrypted bundle goes to the TEE service.
          </Flow>
          <Flow n={2} t="TEE preview">
            Inside the TEE, the runner checks the bundle against its commitments, runs the reference panel (requested: GLM 5.3, Kimi K3, Qwen 3.8, resolved to the exact model IDs served) for one episode
            per task with the network off, and a separate validator model writes a short screened explanation. The report is signed with EIP-712 and its hash attached on-chain.
          </Flow>
          <Flow n={3} t="Buyer pays into escrow">
            The price is locked in the contract and the seller’s collateral is reserved. The buyer supplies an X25519 encryption public key.
          </Flow>
          <Flow n={4} t="Key delivery">
            The TEE relay builds a buyer-specific wrapper, ECIES-wraps the bundle key to the buyer’s key, and records a signed receipt on-chain. If it misses the delivery deadline, anyone can trigger a full
            refund.
          </Flow>
          <Flow n={5} t="Challenge window">
            The buyer decrypts in the browser, checks sha256 against the listing, and may dispute specific tasks under one of three grounds, posting a bond. After the window, anyone can finalize.
          </Flow>
          <Flow n={6} t="Disputes">
            Mechanical grounds are re-checked by the TEE verifier, which signs a finding. False-description claims go to three staked AI jurors drawn with on-chain randomness, who commit and then reveal
            votes. Refunds are per task, at most once each, capped at 50% after delivery.
          </Flow>
          <Flow n={7} t="Reputation">
            Settled purchases feed a per-version star average and a per-seller, money-weighted score that appears after 100 qualifying transactions. Until then: “New seller — N/100 transactions” and the
            stake.
          </Flow>
        </ol>
      </Card>

      <Card title="Trusted parties" subtitle="Each of these can hurt you if it misbehaves or fails.">
        <div className="space-y-5 text-sm leading-relaxed">
          <Trust t="EigenCompute operator and Intel TDX hardware">
            The preview runner, validator, key-delivery relay, and mechanical verifier all run in one app inside an Intel TDX confidential VM on EigenCompute. Its signing key is derived from the
            platform’s KMS, and its attestation binds the key to a specific image digest (see the EigenCloud verification dashboard linked from each report). You trust the hardware vendor, the
            platform’s attestation and KMS, and that the published image does what its source says. Hardware attacks such as TEE.fail (memory interposition, extracted attestation keys) are real; this
            does not mean every deployment is compromised.
          </Trust>
          <Trust t="The TEE app as runner, relay, and verifier" tone="warn">
            One service holds all three roles. It can misreport scores, withhold or botch delivery, or rule wrongly on a mechanical dispute. A signature identifies who produced a report; it does not
            make the report true. Delivery receipts prove a delivery was recorded, not that the key works (that’s disputable). There is no independent second verifier or threshold key release yet.
          </Trust>
          <Trust t="Fireworks AI (inference provider)" tone="bad">
            The reference models, the validator, and the AI jurors call Fireworks AI’s hosted inference API from inside the TEE. During preview episodes the provider therefore receives task text,
            source excerpts, and the agent’s actions, and jurors’ prompts include case evidence. That traffic leaves the TEE’s protected boundary. You are trusting Fireworks not to retain or leak
            it; API terms and TLS do not prove non-retention. The design target is inference inside the attested boundary (confidential GPUs), which is not implemented.
          </Trust>
          <Trust t="AI jurors" tone="warn">
            Jurors are an owner-approved allowlist of controlled agent processes with on-chain stakes. Random selection, commit–reveal, and stake slashing are real, but independence and expertise are
            not demonstrated: they may share a base model’s errors, and agreement with the majority does not establish truth. Appeals to a larger panel are not implemented.
          </Trust>
          <Trust t="On-chain randomness">
            Juror seats come from <span className="font-mono">keccak256(blockhash(selectionBlock), prevrandao, disputeId, round)</span>, using a block that did not exist when the dispute opened. On{" "}
            {CHAIN_NAME}, a single sequencer produces blocks and could in principle bias this; it is not manipulation-proof randomness.
          </Trust>
          <Trust t="Market owner">
            Sets parameters (applied to future purchases only; every purchase snapshots its terms), authorizes runner, relay, and verifier addresses, approves jurors, and withdraws the treasury and the
            neutral reserve. The owner cannot move escrowed funds, collateral, bonds, or claimable balances.
          </Trust>
          <Trust t="Payment token">
            {IS_MAINNET
              ? `Real ${token.symbol} on Base mainnet. Amounts are deliberately tiny, and the contracts are unaudited: use at your own risk.`
              : `${token.symbol} is a test token with no monetary value; balances demonstrate accounting, not economic deterrence.`}
          </Trust>
          <Trust t="This website">
            It reads the chain and the TEE service directly from your browser and verifies hashes, signatures, and decryption locally, but you are trusting the JavaScript it serves. Every check can be
            repeated with the open-source CLI agents.
          </Trust>
        </div>
      </Card>

      <Card title="What the evidence does and doesn’t prove">
        <div className="grid gap-5 text-sm sm:grid-cols-2">
          <div>
            <div className="font-semibold">Proves</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li>Hashes: you receive exactly the committed version (same bytes as the listing).</li>
              <li>The report you read is the one committed on-chain, signed by an authorized runner key.</li>
              <li>Attestation: that key lives in a specific TDX app image.</li>
              <li>Escrow, deadlines, refund caps, bond math, and settlement run as written in the contract, exactly once per purchase.</li>
            </ul>
          </div>
          <div>
            <div className="font-semibold">Does not prove</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li>That training on the environment improves your model. pass@1 measures today’s reference models, nothing more.</li>
              <li>Quality, originality, or ownership. Hashes can’t detect recycled tasks or duplicate sales.</li>
              <li>That a juror or verifier ruled correctly, or that the operator is neutral.</li>
              <li>Anything about reward hacking. It is out of scope for previews, validator probes, and disputes.</li>
            </ul>
          </div>
        </div>
      </Card>

      <Card title="Known limits">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>Buyers can copy the delivered bundle before asking for a refund. The 50% post-delivery cap limits refund farming but can leave an honest buyer under-compensated.</li>
          <li>With five tasks, rounding scores to 5 percentage points hides little: scores are nearly per-task results.</li>
          <li>Fake identities and circular trading can inflate reputation. The seller page shows counterparty concentration, but cannot prove wallets have different owners.</li>
          <li>Buyer-specific wrappers help attribute leaks but are removable and not conclusive evidence.</li>
          <li>Validator prose is capped and screened, but short text can still paraphrase or encode secrets.</li>
          <li>Contracts don’t wake up: someone must call finalize, select jurors, or tally. Every such button here is permissionless.</li>
        </ul>
      </Card>

      <Card title="Production work not done here">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>Inference inside the attested boundary (confidential GPUs covering model weights, memory, and device links) instead of an external API.</li>
          <li>Attested or threshold key release; an independent verifier and rerun path for conflicting findings.</li>
          <li>Open juror admission, manipulation-resistant selection, 7-juror appeals, operator seat caps.</li>
          <li>Independently curated audit tasks, similarity checks against recycled tasks, stronger leak attribution.</li>
          <li>Sybil detection, side-channel review (timing, sizes), multi-tenant isolation, additional environment adapters.</li>
          <li>A contract audit, and calibrated reproducibility tolerances on real hardware.</li>
        </ul>
      </Card>

      <LiveParams />
      <LiveDeployment />
    </div>
  );
}

function Flow({ n, t, children }: { n: number; t: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
      <div>
        <div className="font-medium">{t}</div>
        <p className="mt-0.5 text-muted">{children}</p>
      </div>
    </li>
  );
}

function Trust({ t, children, tone }: { t: string; children: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="flex gap-3">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-info"}`} />
      <div>
        <div className="font-semibold">{t}</div>
        <p className="mt-0.5 text-muted">{children}</p>
      </div>
    </div>
  );
}

function LiveParams() {
  const q = useMarketParams();
  const p = q.data;
  if (!deployment) return null;
  return (
    <Card title="Live parameters" subtitle="Read from params() now. They apply to new purchases and disputes; existing ones keep their snapshot.">
      {!p ? (
        <p className="text-sm text-muted">{q.error ? "Could not read parameters." : "Loading…"}</p>
      ) : (
        <dl className="kv">
          <dt>Challenge window</dt>
          <dd>{fmtWindow(p.challengeWindow)}</dd>
          <dt>Delivery window</dt>
          <dd>{fmtWindow(p.deliveryWindow)}</dd>
          <dt>Refund cap</dt>
          <dd>{pct(p.refundCapBps)} of price</dd>
          <dt>Penalty</dt>
          <dd>
            {pct(p.penaltyBps)} of price if &gt; {pct(p.penaltyThresholdBps)} of tasks are confirmed defective
          </dd>
          <dt>Marketplace fee</dt>
          <dd>{pct(p.feeBps)}</dd>
          <dt>Bond</dt>
          <dd>
            clamp(requested, {fmtUsdc(p.bondFloor)}, {fmtUsdc(p.bondCap)})
          </dd>
          <dt>Case fee</dt>
          <dd>{fmtUsdc(p.caseFee)}</dd>
          <dt>Juror stake / participation</dt>
          <dd>
            {fmtUsdc(p.jurorStake)} / {fmtUsdc(p.participationFee)}
          </dd>
          <dt>Slashing</dt>
          <dd>
            minority {pct(p.minoritySlashBps)} · non-reveal {pct(p.nonRevealSlashBps)} of seat stake
          </dd>
          <dt>Commit / reveal</dt>
          <dd>
            {fmtWindow(p.commitWindow)} / {fmtWindow(p.revealWindow)}
          </dd>
          <dt>Verifier timeout</dt>
          <dd>{fmtWindow(p.verifierTimeout)}</dd>
        </dl>
      )}
    </Card>
  );
}

function LiveDeployment() {
  const health = useHealth();
  const att = useAttestation();
  return (
    <Card title="This deployment">
      <dl className="kv">
        <dt>Chain</dt>
        <dd>
          {CHAIN_NAME} ({CHAIN_ID})
        </dd>
        <dt>EnvMarket</dt>
        <dd>{deployment ? <AddressLink address={deployment.market} /> : "not deployed"}</dd>
        <dt>Payment token</dt>
        <dd>{deployment ? <AddressLink address={deployment.token} /> : "—"}</dd>
        <dt>TEE service</dt>
        <dd className="break-all">{TEE_URL || "not configured"}</dd>
        <dt>TEE signer</dt>
        <dd>{health.data?.signer ? <AddressLink address={health.data.signer} /> : health.error ? <span className="text-bad">unreachable</span> : "…"}</dd>
        <dt>Attestation</dt>
        <dd className="text-xs">
          {att.data ? (
            <details>
              <summary className="cursor-pointer text-accent">{String(att.data.kind ?? att.data.type ?? "view /attestation response")}</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px]">{JSON.stringify(att.data, null, 2)}</pre>
            </details>
          ) : att.error ? (
            <span className="text-bad">unavailable</span>
          ) : (
            "…"
          )}
        </dd>
      </dl>
      <p className="mt-3 text-xs text-muted">
        Source: the protocol design is in <span className="font-mono">docs/RL_ENV_MARKET.md</span>; interfaces in <span className="font-mono">docs/BUILD_SPEC.md</span>.{" "}
        <Link href="/" className="link">
          Back to the marketplace
        </Link>
      </p>
    </Card>
  );
}
