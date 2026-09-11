/**
 * Durable per-juror state in `.data/juror{n}.json`: log cursor, per-dispute/round decisions and
 * vote secrets. Every write is atomic (tmp file + fsync + rename + dir fsync) so a crash never
 * leaves a half-written file, and the salt/verdict are on disk BEFORE commitVote is sent.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Hex } from 'viem';
import type { JurorOutput, ScreenedPublic } from './rubric.ts';

export interface Decision {
  output: JurorOutput;
  public: ScreenedPublic;
  model: { provider: string; baseUrl: string; requested: string; resolved: string; served: string };
  promptVersion: string;
  promptHash: Hex;
  packetSha256: Hex;
  attempts: number;
  decidedAt: string;
}

export interface RoundRecord {
  round: number;
  decision?: Decision;
  /** Vote secret; written before the commit tx and never regenerated. */
  verdict?: 'Uphold' | 'Reject';
  salt?: Hex;
  commitment?: Hex;
  commitTx?: Hex;
  commitConfirmed?: boolean;
  revealTx?: Hex;
  revealConfirmed?: boolean;
  rationalePublished?: { file: string; sha256: Hex; blobUrl?: string };
  abstainReason?: string;
}

export interface DisputeRecord {
  disputeId: string;
  purchaseId?: string;
  discoveredAtBlock?: string;
  rounds: Record<string, RoundRecord>;
  resolved?: boolean;
  finalVerdict?: string;
  withdrawTx?: Hex;
}

export interface DeploymentState {
  cursor: string; // last fully processed block (decimal string)
  disputes: Record<string, DisputeRecord>;
}

export interface JurorStateFile {
  version: 1;
  juror: string;
  /** keyed by `${chainId}:${marketLowercase}` so redeploys never mix secrets */
  deployments: Record<string, DeploymentState>;
}

export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    const dfd = openSync(path.dirname(file), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported on some platforms */
  }
}

export class JurorStore {
  readonly file: string;
  private data: JurorStateFile;
  readonly key: string;

  constructor(file: string, juror: string, chainId: number, market: string, startBlock: bigint) {
    this.file = file;
    this.key = `${chainId}:${market.toLowerCase()}`;
    if (existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as JurorStateFile;
      if (this.data.version !== 1) throw new Error(`${file}: unsupported state version`);
      if (this.data.juror.toLowerCase() !== juror.toLowerCase()) throw new Error(`${file} belongs to ${this.data.juror}, not ${juror}`);
    } else {
      this.data = { version: 1, juror, deployments: {} };
    }
    if (!this.data.deployments[this.key]) {
      this.data.deployments[this.key] = { cursor: (startBlock > 0n ? startBlock - 1n : 0n).toString(), disputes: {} };
      this.save();
    }
  }

  private get dep(): DeploymentState {
    return this.data.deployments[this.key]!;
  }

  get cursor(): bigint {
    return BigInt(this.dep.cursor);
  }

  setCursor(b: bigint): void {
    if (b <= this.cursor) return;
    this.dep.cursor = b.toString();
    this.save();
  }

  disputes(): DisputeRecord[] {
    return Object.values(this.dep.disputes);
  }

  dispute(id: bigint): DisputeRecord | undefined {
    return this.dep.disputes[id.toString()];
  }

  ensureDispute(id: bigint, init: Partial<DisputeRecord> = {}): DisputeRecord {
    const k = id.toString();
    if (!this.dep.disputes[k]) {
      this.dep.disputes[k] = { disputeId: k, rounds: {}, ...init };
      this.save();
    }
    return this.dep.disputes[k]!;
  }

  round(id: bigint, round: number): RoundRecord {
    const d = this.ensureDispute(id);
    const k = String(round);
    if (!d.rounds[k]) d.rounds[k] = { round };
    return d.rounds[k]!;
  }

  /** Mutate then persist durably. */
  update<T>(fn: () => T): T {
    const r = fn();
    this.save();
    return r;
  }

  save(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

/** Single-instance lock per juror: refuses to start if another live process holds it. */
export function acquireLock(lockFile: string): () => void {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) throw new Error(`another process (pid ${pid}) holds ${lockFile}`);
  }
  writeFileAtomic(lockFile, String(process.pid));
  return () => {
    try {
      if (existsSync(lockFile) && readFileSync(lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  };
}
