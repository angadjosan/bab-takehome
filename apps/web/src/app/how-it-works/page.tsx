"use client";

import type { ReactNode } from "react";
import { useTokenInfo } from "@/components/providers";
import { AddressLink, Card, Chip, PageHeader, Skeleton } from "@/components/ui";
import { CHAIN_ID, CHAIN_NAME, IS_MAINNET, deployment, TEE_URL, TEE_VIA_PROXY } from "@/lib/config";
import { useAttestation, useHealth } from "@/lib/docs";
import { fmtUsdc, fmtWindow, pct } from "@/lib/format";
import { useMarketParams } from "@/lib/market";

const SECTIONS = [
  { id: "flow", label: "The flow" },
  { id: "trust", label: "Who you’re trusting" },
  { id: "evidence", label: "What the evidence proves" },
  { id: "limits", label: "Known limits" },
  { id: "not-built", label: "Not built yet" },
  { id: "parameters", label: "Live parameters" },
  { id: "deployment", label: "This deployment" },
];

export default function HowItWorks() {
  const token = useTokenInfo();
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="min-w-0 max-w-3xl space-y-14">
        <PageHeader eyebrow="How it works" title="What you’re trusting when you buy here">
          <p>
            An RL environment is a practice ground for an AI agent: tasks, tools, and a grader. Showing the tasks and hidden tests gives the product away, so it has to be sold before anyone
            inspects it. This market puts a signed preview, escrow, a short protection window with capped refunds, and purchase-linked reputation in place of inspection. Each of those rests on
            someone you have to trust, and this page names them.
          </p>
        </PageHeader>

        <Section id="flow" title="The flow">
          <ol className="space-y-6">
            <Flow n={1} t="The seller lists a version">
              The listing commits to hashes of the plaintext bundle, the ciphertext, the image, the description, manifest and license, plus Merkle roots over salted task commitments
              (purchased and audit-holdout tasks), a price, and collateral. The encrypted bundle goes to the TEE service.
            </Flow>
            <Flow n={2} t="The TEE runs a preview">
              Inside the TEE, the runner checks the bundle against its commitments and runs the reference panel (GLM 5.3, Kimi K3 and Qwen 3.8, pinned to the Fireworks model IDs glm-5p3,
              kimi-k3 and qwen3p8-max and recorded exactly in the report) for one episode per task, with the sandbox network off. A validator from a different model family
              (deepseek-v4-pro) writes a short, screened explanation. The report is signed with EIP-712 and its hash is attached on-chain.
            </Flow>
            <Flow n={3} t="The buyer pays into escrow">
              The contract holds the price and reserves the seller’s collateral for this purchase. The buyer’s delivery key (an X25519 public key derived from their wallet) is recorded with
              the payment.
            </Flow>
            <Flow n={4} t="The TEE delivers the key">
              The relay builds a buyer-specific wrapper, wraps the bundle key to the buyer’s key, and records a signed receipt on-chain. If it misses the delivery deadline, anyone can
              trigger a full refund.
            </Flow>
            <Flow n={5} t="The protection window runs">
              The buyer’s browser decrypts the bundle and checks its sha256 against the listing. Until the window closes, the buyer can report specific tasks under one of three grounds by
              posting a deposit. After it closes, anyone can release the payment.
            </Flow>
            <Flow n={6} t="Disputes are decided">
              The TEE verifier rechecks mechanical grounds and signs a finding. Claims that the description is false go to three staked AI jurors drawn with on-chain randomness; they commit
              sealed votes, then reveal them. Refunds are per task, at most once each, and capped after delivery.
            </Flow>
            <Flow n={7} t="Reputation updates">
              Settled purchases feed a star average for the version and a money-weighted score for the seller, which appears after 100 qualifying sales. Until then the page shows “New seller ·
              N/100 sales” and the seller’s stake.
            </Flow>
          </ol>
        </Section>

        <Section id="trust" title="Who you’re trusting" lead="Each of these can hurt a buyer if it misbehaves or fails.">
          <div className="divide-y divide-line border-y border-line">
            <Trust t="Phala Cloud (dstack) operator, its KMS and Intel TDX hardware">
              The preview runner, validator, key-delivery relay and mechanical verifier all run in one app inside an Intel TDX confidential VM on Phala Cloud (dstack). Its signing key comes from
              Phala’s KMS for this app, and its TDX quote binds the key to a compose file that pins the image by digest (each report links to the Phala Trust Center, and this site re-checks the
              quote). You trust the hardware vendor, Phala’s KMS operator, and that the published image does what its source says. The developer can push a new image to the same app. Hardware attacks such as TEE.fail (memory interposition, extracted attestation keys) exist;
              they don’t mean every deployment is compromised.
            </Trust>
            <Trust t="The TEE app as runner, relay and verifier" flag={{ tone: "warn", label: "Single operator" }}>
              One service holds all three roles. It can misreport scores, withhold or botch a delivery, or rule wrongly on a mechanical dispute. A signature identifies who produced a report and
              doesn’t make the report true. A delivery receipt proves a delivery was recorded; whether the key works is disputable. There is no independent second verifier or threshold key
              release yet.
            </Trust>
            <Trust t="Fireworks AI (inference provider)" flag={{ tone: "bad", label: "Data leaves the TEE" }}>
              The reference models, the validator and the AI jurors call Fireworks AI’s hosted inference API from inside the TEE. During preview episodes Fireworks receives task text, source
              excerpts and the agent’s actions, and juror prompts include case evidence. You are trusting Fireworks not to retain or leak it; API terms and TLS don’t prove non-retention.
              Running inference inside the attested boundary (confidential GPUs) is the design target and isn’t built.
            </Trust>
            <Trust t="AI jurors" flag={{ tone: "warn", label: "Unproven independence" }}>
              Jurors are an owner-approved list of agent processes with on-chain stakes. Random selection, commit and reveal, and slashing are real. Their independence and expertise are not
              demonstrated: they may share a base model’s errors, and agreeing with the majority doesn’t make a vote correct. Appeals to a larger panel aren’t implemented.
            </Trust>
            <Trust t="On-chain randomness">
              Juror seats come from <span className="font-mono text-ink">keccak256(blockhash(selectionBlock), prevrandao, disputeId, round)</span>, using a block that didn’t exist when the
              dispute opened. On {CHAIN_NAME} a single sequencer produces blocks and could in principle bias this.
            </Trust>
            <Trust t="Market owner">
              Sets parameters (future purchases only; every purchase snapshots its terms), authorizes the runner, relay and verifier addresses, approves jurors, and withdraws the treasury and
              neutral reserve. The owner can’t move escrowed funds, collateral, deposits or withdrawable balances.
            </Trust>
            <Trust t="Payment token">
              {IS_MAINNET
                ? `Real ${token.symbol} on Base mainnet. Amounts are deliberately tiny and the contracts are unaudited.`
                : `${token.symbol} is a test token with no monetary value. Balances show the accounting working; they don’t deter anyone economically.`}
            </Trust>
            <Trust t="This website">
              It reads the chain and the TEE service from your browser and verifies hashes, signatures and decryption locally, so you are trusting the JavaScript it serves. The open-source CLI
              agents repeat every check. The TEE serves plain http, so the browser reaches it through this site’s /api/tee proxy; the proxy only relays bytes, and every document is still
              checked against its on-chain hash here.
            </Trust>
          </div>
        </Section>

        <Section id="evidence" title="What the evidence proves">
          <div className="grid gap-8 sm:grid-cols-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
                <Chip tone="ok">Proves</Chip>
              </h3>
              <ul className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-muted">
                <li>You receive exactly the committed version: the same bytes as the listing.</li>
                <li>The report you read is the one committed on-chain, signed by an authorized runner key.</li>
                <li>The attestation ties that key to a specific TDX app image.</li>
                <li>Escrow, deadlines, refund caps, deposit math and settlement run as the contract is written, once per purchase.</li>
              </ul>
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
                <Chip tone="warn">Doesn’t prove</Chip>
              </h3>
              <ul className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-muted">
                <li>That training on the environment improves your model. pass@1 measures today’s reference models on these tasks.</li>
                <li>Quality, originality or ownership. Hashes can’t detect recycled tasks or duplicate sales.</li>
                <li>That a juror or verifier ruled correctly, or that the operator is neutral.</li>
                <li>Anything about reward hacking, which previews, validator probes and disputes don’t cover.</li>
              </ul>
            </div>
          </div>
        </Section>

        <Section id="limits" title="Known limits">
          <Bullets
            items={[
              "Buyers can copy the delivered bundle before asking for a refund. The post-delivery cap limits refund farming and can leave an honest buyer under-compensated.",
              "With five tasks, rounding scores to 5 percentage points hides little: scores are close to per-task results.",
              "Fake identities and circular trading can inflate reputation. The account page shows counterparty concentration but can’t prove two wallets have different owners.",
              "Buyer-specific wrappers help attribute leaks, but they can be removed and aren’t conclusive evidence.",
              "Validator prose is capped and screened, and short text can still paraphrase or encode secrets.",
              "Nothing on-chain moves by itself. Someone has to release payments, draw jurors, or count votes, and every such button here works for any wallet.",
            ]}
          />
        </Section>

        <Section id="not-built" title="Not built yet">
          <Bullets
            items={[
              "Inference inside the attested boundary (confidential GPUs covering model weights, memory and device links) instead of an external API.",
              "Attested or threshold key release; an independent verifier and a rerun path for conflicting findings.",
              "Open juror admission, manipulation-resistant selection, 7-juror appeals, operator seat caps.",
              "Independently curated audit tasks, similarity checks against recycled tasks, stronger leak attribution.",
              "Sybil detection, side-channel review (timing, sizes), multi-tenant isolation, more environment adapters.",
              "A contract audit, and reproducibility tolerances calibrated on real hardware.",
            ]}
          />
        </Section>

        <LiveParams />
        <LiveDeployment />
      </div>

      <nav aria-label="On this page" className="hidden lg:block">
        <div className="sticky top-28 space-y-2">
          <div className="section-title">On this page</div>
          <ul className="space-y-1.5 border-l border-line text-[13px]">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="-ml-px block border-l border-transparent pl-3 text-muted transition-colors duration-150 hover:border-accent hover:text-ink">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="space-y-5">
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {lead && <p className="mt-1 text-[13px] text-muted">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function Flow({ n, t, children }: { n: number; t: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      <span className="pt-0.5 font-mono text-[11px] text-accent tabular-nums">{String(n).padStart(2, "0")}</span>
      <div>
        <div className="text-sm font-medium text-ink">{t}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

function Trust({ t, children, flag }: { t: string; children: ReactNode; flag?: { tone: "warn" | "bad"; label: string } }) {
  return (
    <div className="py-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-ink">{t}</h3>
        {flag && <Chip tone={flag.tone}>{flag.label}</Chip>}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-[13px] leading-relaxed text-muted">
      {items.map((x) => (
        <li key={x} className="grid grid-cols-[1rem_minmax(0,1fr)]">
          <span aria-hidden className="text-faint">
            –
          </span>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}

function LiveParams() {
  const q = useMarketParams();
  const p = q.data;
  if (!deployment) return null;
  return (
    <Section id="parameters" title="Live parameters" lead="Read from the contract now. Changes apply to new purchases and disputes; existing ones keep the terms they started with.">
      <Card>
        {!p ? (
          q.error ? (
            <p className="text-sm text-bad">Couldn’t read parameters from the contract. Reload to try again.</p>
          ) : (
            <Skeleton className="h-48" />
          )
        ) : (
          <dl className="kv">
            <dt>Protection window</dt>
            <dd>{fmtWindow(p.challengeWindow)} after delivery</dd>
            <dt>Delivery deadline</dt>
            <dd>{fmtWindow(p.deliveryWindow)} after payment</dd>
            <dt>Refund cap</dt>
            <dd>{pct(p.refundCapBps)} of the price</dd>
            <dt>Seller penalty</dt>
            <dd>
              {pct(p.penaltyBps)} of the price if more than {pct(p.penaltyThresholdBps)} of tasks are confirmed defective
            </dd>
            <dt>Marketplace fee</dt>
            <dd>{pct(p.feeBps)}</dd>
            <dt>Report deposit</dt>
            <dd>
              the requested refund, kept between <span className="font-mono tabular-nums">{fmtUsdc(p.bondFloor)}</span> and{" "}
              <span className="font-mono tabular-nums">{fmtUsdc(p.bondCap)}</span>
            </dd>
            <dt>Case fee</dt>
            <dd className="font-mono tabular-nums">{fmtUsdc(p.caseFee)}</dd>
            <dt>Juror stake / pay</dt>
            <dd className="font-mono tabular-nums">
              {fmtUsdc(p.jurorStake)} / {fmtUsdc(p.participationFee)}
            </dd>
            <dt>Juror slashing</dt>
            <dd>
              {pct(p.minoritySlashBps)} for voting with the minority · {pct(p.nonRevealSlashBps)} for not revealing
            </dd>
            <dt>Vote / reveal windows</dt>
            <dd>
              {fmtWindow(p.commitWindow)} / {fmtWindow(p.revealWindow)}
            </dd>
            <dt>Verifier timeout</dt>
            <dd>{fmtWindow(p.verifierTimeout)}</dd>
          </dl>
        )}
      </Card>
    </Section>
  );
}

function LiveDeployment() {
  const health = useHealth();
  const att = useAttestation();
  return (
    <Section id="deployment" title="This deployment">
      <Card>
        <dl className="kv">
          <dt>Chain</dt>
          <dd>
            {CHAIN_NAME} <span className="font-mono text-muted">({CHAIN_ID})</span>
          </dd>
          <dt>Market contract</dt>
          <dd>{deployment ? <AddressLink address={deployment.market} /> : "not deployed"}</dd>
          <dt>Payment token</dt>
          <dd>{deployment ? <AddressLink address={deployment.token} /> : "—"}</dd>
          <dt>TEE service</dt>
          <dd>{TEE_VIA_PROXY ? "reached through this site’s /api/tee proxy (the TEE serves plain http; the proxy only relays bytes)" : <span className="font-mono">{TEE_URL || "not configured"}</span>}</dd>
          <dt>TEE signer</dt>
          <dd>{health.data?.signer ? <AddressLink address={health.data.signer} /> : health.error ? <span className="text-bad">unreachable</span> : "…"}</dd>
          <dt>Attestation</dt>
          <dd className="text-xs">
            {att.data ? (
              <details>
                <summary className="cursor-pointer text-muted hover:text-ink">{String(att.data.kind ?? att.data.type ?? "Show /attestation response")}</summary>
                <pre className="mt-2 max-h-60 overflow-auto rounded bg-panel-2 p-3 font-mono text-[11px]">{JSON.stringify(att.data, null, 2)}</pre>
              </details>
            ) : att.error ? (
              <span className="text-bad">unavailable</span>
            ) : (
              "…"
            )}
          </dd>
        </dl>
        <p className="mt-4 text-xs text-muted">
          The protocol design is in <span className="font-mono">docs/RL_ENV_MARKET.md</span> and the interfaces in <span className="font-mono">docs/BUILD_SPEC.md</span>.
        </p>
      </Card>
    </Section>
  );
}
