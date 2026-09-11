/**
 * GET /api/health: public juror identities and on-chain state (addresses, approval, stake,
 * claimable, gas balance), model pins, prompt hash, config flags. Never returns a secret: only
 * booleans for whether keys are configured.
 */
import { formatEther, formatUnits } from 'viem';
import { jurorAddresses, loadConfig, publicClientFor } from '../../../lib/config.ts';
import { json } from '../../../lib/http.ts';
import { loadAbi } from '../../../shared-lite.ts';
import { PINNED_FIREWORKS_MODELS } from '../../../vendor/jurors/src/llm.ts';
import { PROMPT_SHA256, PROMPT_VERSION } from '../../../vendor/prompt-text.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  try {
    const cfg = loadConfig();
    const pc = publicClientFor(cfg);
    const abi = loadAbi('EnvMarket');
    const read = <T,>(functionName: string, args: readonly unknown[] = []) => pc.readContract({ address: cfg.market, abi, functionName, args } as never) as Promise<T>;
    const [block, nextDisputeId, params] = await Promise.all([pc.getBlockNumber(), read<bigint>('nextDisputeId'), read<{ jurorStake: bigint }>('params')]);
    const jurors = await Promise.all(
      jurorAddresses().map(async ({ index, address }) => {
        const [[approved, total, locked, free], claimable, gas] = await Promise.all([
          read<[boolean, bigint, bigint, bigint]>('jurorInfo', [address]),
          read<bigint>('claimable', [address]),
          pc.getBalance({ address }),
        ]);
        return {
          index,
          address,
          approved,
          stake: { total: formatUnits(total, 6), locked: formatUnits(locked, 6), free: formatUnits(free, 6), seatsAvailable: params.jurorStake > 0n ? Number(free / params.jurorStake) : null },
          claimable: formatUnits(claimable, 6),
          gasEth: formatEther(gas),
          model: PINNED_FIREWORKS_MODELS[index],
        };
      }),
    );
    return json({
      ok: jurors.length === 3,
      service: 'envmarket-jurors (Vercel Functions + Vercel Workflow)',
      enabled: cfg.enabled,
      chainId: cfg.chainId,
      market: cfg.market,
      block,
      nextDisputeId,
      tee: cfg.teeUrl,
      keeperJuror: cfg.keeperIndex,
      prompt: { version: PROMPT_VERSION, sha256: PROMPT_SHA256 },
      inference: { fireworksKeyConfigured: Boolean(process.env.FIREWORKS_API_KEY) },
      jurorKeysConfigured: jurors.length,
      jurorStakeTusdc: formatUnits(params.jurorStake, 6),
      jurors,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.JURORS_COMMIT ?? null,
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}
