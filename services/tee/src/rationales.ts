/**
 * Juror rationale publication and discovery.
 *
 * POST /rationales/:disputeId  body {docJson, signature}
 *   docJson   = the juror's screened rationale (envmarket.juror-rationale.v1) as the exact JSON text
 *   signature = EIP-191 signature by doc.juror over the raw sha256(docJson bytes)
 *   Accepted only from a juror seated on that dispute in doc.round whose reveal is already on-chain,
 *   with doc.verdict / doc.commitment equal to the revealed seat. The exact bytes are stored in the
 *   public blob store (sha256-addressed) and indexed per dispute (latest per juror+round).
 * GET /rationales/:disputeId
 *   Indexed rationales whose juror's reveal is on-chain, with their text, so clients can list them
 *   without an on-chain pointer. Clients re-check the hash and the seat themselves.
 */
import { sha256Hex } from '@envmarket/shared';
import { getAddress, recoverMessageAddress, type Hex } from 'viem';
import { requireChain, type Ctx } from './context.ts';
import { HttpError } from './preview.ts';

export const RATIONALE_TYPE = 'envmarket.juror-rationale.v1';
const MAX_BYTES = 64 * 1024;

type Entry = { juror: string; round: number; sha256: Hex; storedAt: string };

const NS = 'rationales';
const key = (disputeId: bigint) => `d${disputeId}`;
const verdictName = (vote: number) => (vote === 1 ? 'Uphold' : vote === 2 ? 'Reject' : 'None');

export async function storeRationale(ctx: Ctx, disputeId: bigint, body: Record<string, unknown>): Promise<{ sha256: Hex; url: string }> {
  const { docJson, signature } = body as { docJson?: unknown; signature?: unknown };
  if (typeof docJson !== 'string' || typeof signature !== 'string') throw new HttpError(400, 'docJson (string) and signature are required');
  const bytes = new TextEncoder().encode(docJson);
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new HttpError(413, `rationale must be 1..${MAX_BYTES} bytes`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(docJson) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'docJson is not JSON');
  }
  if (doc.type !== RATIONALE_TYPE) throw new HttpError(400, `type must be ${RATIONALE_TYPE}`);
  const chain = requireChain(ctx);
  if (Number(doc.chainId) !== chain.chainId || String(doc.market).toLowerCase() !== chain.market.toLowerCase()) throw new HttpError(400, 'rationale is for another chain or market');
  if (String(doc.disputeId) !== disputeId.toString()) throw new HttpError(400, 'rationale is for another dispute');
  const round = Number(doc.round);
  if (round !== 1 && round !== 2) throw new HttpError(400, 'round must be 1 or 2');
  let juror: string;
  try {
    juror = getAddress(String(doc.juror)).toLowerCase();
  } catch {
    throw new HttpError(400, 'bad juror address');
  }

  const hash = sha256Hex(bytes);
  const signer = await recoverMessageAddress({ message: { raw: hash }, signature: signature as Hex }).catch(() => null);
  if (!signer || signer.toLowerCase() !== juror) throw new HttpError(401, 'signature is not by doc.juror');

  const got = await chain.getDispute(disputeId);
  if (!got) throw new HttpError(404, 'dispute not found');
  const seat = got.seats.slice((round - 1) * 3, round * 3).find((s) => s.juror.toLowerCase() === juror);
  if (!seat) throw new HttpError(403, `address is not seated in round ${round} of this dispute`);
  if (!seat.revealed) throw new HttpError(409, 'publish after your reveal is on-chain');
  if (doc.verdict !== verdictName(seat.vote)) throw new HttpError(400, 'verdict does not match the revealed vote');
  if (String(doc.commitment).toLowerCase() !== seat.commitment.toLowerCase()) throw new HttpError(400, 'commitment does not match the seat');

  ctx.blobs.put(bytes);
  const list = ctx.priv.get<Entry[]>(NS, key(disputeId)) ?? [];
  if (!list.some((e) => e.sha256 === hash)) {
    const rest = list.filter((e) => !(e.juror === juror && e.round === round));
    ctx.priv.put<Entry[]>(NS, key(disputeId), [...rest, { juror, round, sha256: hash, storedAt: new Date().toISOString() }]);
  }
  return { sha256: hash, url: `${ctx.cfg.publicUrl}/blobs/${hash.slice(2)}` };
}

export async function listRationales(
  ctx: Ctx,
  disputeId: bigint,
): Promise<{ disputeId: string; rationales: Array<Entry & { url: string; docJson: string | null }> }> {
  const list = ctx.priv.get<Entry[]>(NS, key(disputeId)) ?? [];
  if (!list.length) return { disputeId: disputeId.toString(), rationales: [] };
  const got = await requireChain(ctx).getDispute(disputeId);
  const revealed = (e: Entry) => !!got && got.seats.slice((e.round - 1) * 3, e.round * 3).some((s) => s.juror.toLowerCase() === e.juror && s.revealed);
  return {
    disputeId: disputeId.toString(),
    rationales: list.filter(revealed).map((e) => ({ ...e, url: `${ctx.cfg.publicUrl}/blobs/${e.sha256.slice(2)}`, docJson: ctx.blobs.getText(e.sha256) })),
  };
}
