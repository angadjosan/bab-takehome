/**
 * Task commitments, Merkle trees, salts, juror vote commitments.
 *
 * leaf = keccak256(abi.encode(domain, environmentVersion, taskId, taskHash, graderDigest, salt))
 *   domain            string  "envmarket.task.v1" (purchased) | "envmarket.audit.v1" (audit)
 *   environmentVersion string
 *   taskId            string
 *   taskHash          bytes32 sha256(canonical tar of tasks/<taskId>/, paths relative to that dir)
 *   graderDigest      bytes32 sha256(canonical tar of grader/)
 *   salt              bytes32 random
 *
 * Merkle: @openzeppelin/merkle-tree `SimpleMerkleTree` (sorted-pair keccak256 = OZ
 * `Hashes.commutativeKeccak256`, verifiable with OZ `MerkleProof.sol`), leaves supplied by us and
 * NOT re-sorted. Tree shape is OZ's complete-binary-tree array layout (for leaf counts that are
 * not a power of two this differs from "promote the odd node"). Leaves are ordered by taskId
 * ascending (ASCII), and that index is the task's bit in on-chain `taskMask`.
 */
import * as path from 'node:path';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { bytesToHex, normalizeBytes32, sha256Hex } from './hash.ts';
import { canonicalTarOfDir, type DirTarOptions } from './tar.ts';

export const TASK_DOMAIN = 'envmarket.task.v1';
export const AUDIT_DOMAIN = 'envmarket.audit.v1';
export const MAX_TASKS = 256; // taskMask is uint256

const LEAF_PARAMS = parseAbiParameters('string, string, string, bytes32, bytes32, bytes32');

export interface LeafInput {
  environmentVersion: string;
  taskId: string;
  taskHash: Hex;
  graderDigest: Hex;
  salt: Hex;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Task ids are ASCII path-safe segments (they name `tasks/<taskId>/`). */
export function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId) || taskId === '.' || taskId === '..') {
    throw new Error(`invalid taskId ${JSON.stringify(taskId)} (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,127})`);
  }
}

/** The abi.encode payload hashed into a leaf (exposed for cross-checking with Solidity/cast). */
export function encodeLeafPayload(input: LeafInput, domain: string = TASK_DOMAIN): Hex {
  return encodeAbiParameters(LEAF_PARAMS, [
    domain,
    input.environmentVersion,
    input.taskId,
    normalizeBytes32(input.taskHash, 'taskHash'),
    normalizeBytes32(input.graderDigest, 'graderDigest'),
    normalizeBytes32(input.salt, 'salt'),
  ]);
}

/** Purchased-task leaf (domain "envmarket.task.v1" unless overridden). */
export function taskLeaf(input: LeafInput, domain: string = TASK_DOMAIN): Hex {
  return keccak256(encodeLeafPayload(input, domain));
}

/** Audit-task leaf (domain "envmarket.audit.v1"). */
export function auditLeaf(input: LeafInput): Hex {
  return taskLeaf(input, AUDIT_DOMAIN);
}

/** taskHash for a task directory: sha256 of its canonical tar (paths relative to the task dir). */
export function taskHashOfDir(taskDir: string, opts: DirTarOptions = {}): Hex {
  return sha256Hex(canonicalTarOfDir(taskDir, opts));
}

/** graderDigest: sha256 of the canonical tar of the grader directory. */
export function graderDigestOfDir(graderDir: string, opts: DirTarOptions = {}): Hex {
  return sha256Hex(canonicalTarOfDir(graderDir, opts));
}

/** Convenience: taskHash of `<payloadRoot>/tasks/<taskId>`. */
export function taskHashInPayload(payloadRoot: string, taskId: string, opts: DirTarOptions = {}): Hex {
  assertTaskId(taskId);
  return taskHashOfDir(path.join(payloadRoot, 'tasks', taskId), opts);
}

/** 32 cryptographically random bytes as bytes32 hex. */
export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** OZ `Hashes.commutativeKeccak256`: keccak256 of the two nodes in ascending order. */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = normalizeBytes32(a, 'node');
  const y = normalizeBytes32(b, 'node');
  return keccak256(x < y ? concat([x, y]) : concat([y, x]));
}

/**
 * The @openzeppelin/merkle-tree `SimpleMerkleTree` over caller-supplied leaves, in the given
 * order (`sortLeaves: false`, so leaf index == taskMask bit).
 */
export function merkleTree(leaves: Hex[]): SimpleMerkleTree {
  if (leaves.length === 0) throw new Error('merkle: no leaves');
  return SimpleMerkleTree.of(
    leaves.map((l) => normalizeBytes32(l, 'leaf')),
    { sortLeaves: false },
  );
}

export function merkleRoot(leaves: Hex[]): Hex {
  return merkleTree(leaves).root as Hex;
}

/** Proof for leaf `index` (OZ tree layout; verifiable with OZ `MerkleProof.verify`). */
export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error('merkle: index out of range');
  return merkleTree(leaves).getProof(index) as Hex[];
}

/** OZ `MerkleProof.processProof`. */
export function processMerkleProof(leaf: Hex, proof: Hex[]): Hex {
  return proof.reduce<Hex>((acc, p) => hashPair(acc, p), normalizeBytes32(leaf, 'leaf'));
}

/** OZ `MerkleProof.verify` (via `SimpleMerkleTree.verify`). */
export function verifyMerkleProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  try {
    return SimpleMerkleTree.verify(normalizeBytes32(root, 'root'), normalizeBytes32(leaf, 'leaf'), proof.map((p) => normalizeBytes32(p, 'proof')));
  } catch {
    return false;
  }
}

export interface TaskTreeTask {
  taskId: string;
  taskHash: Hex;
  salt: Hex;
}

export interface TaskTreeLeaf extends TaskTreeTask {
  index: number;
  leaf: Hex;
  proof: Hex[];
}

export interface TaskTree {
  domain: string;
  environmentVersion: string;
  graderDigest: Hex;
  root: Hex;
  leaves: TaskTreeLeaf[]; // sorted by taskId; index == taskMask bit
  byId: Record<string, TaskTreeLeaf>;
}

/** Sort task ids into canonical order (ASCII ascending). */
export function sortTaskIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Build the commitment tree for a set of tasks (purchased or audit, by `domain`). */
export function buildTaskTree(args: {
  environmentVersion: string;
  graderDigest: Hex;
  tasks: TaskTreeTask[];
  domain?: string;
}): TaskTree {
  const domain = args.domain ?? TASK_DOMAIN;
  if (args.tasks.length === 0) throw new Error('task tree: no tasks');
  if (args.tasks.length > MAX_TASKS) throw new Error(`task tree: at most ${MAX_TASKS} tasks`);
  const seen = new Set<string>();
  for (const t of args.tasks) {
    assertTaskId(t.taskId);
    if (seen.has(t.taskId)) throw new Error(`task tree: duplicate taskId ${t.taskId}`);
    seen.add(t.taskId);
  }
  const sorted = [...args.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const leafHashes = sorted.map((t) =>
    taskLeaf({ environmentVersion: args.environmentVersion, taskId: t.taskId, taskHash: t.taskHash, graderDigest: args.graderDigest, salt: t.salt }, domain),
  );
  const tree = merkleTree(leafHashes);
  const root = tree.root as Hex;
  const leaves: TaskTreeLeaf[] = sorted.map((t, index) => ({
    taskId: t.taskId,
    taskHash: normalizeBytes32(t.taskHash, 'taskHash'),
    salt: normalizeBytes32(t.salt, 'salt'),
    index,
    leaf: leafHashes[index]!,
    proof: tree.getProof(index) as Hex[],
  }));
  return {
    domain,
    environmentVersion: args.environmentVersion,
    graderDigest: normalizeBytes32(args.graderDigest, 'graderDigest'),
    root,
    leaves,
    byId: Object.fromEntries(leaves.map((l) => [l.taskId, l])),
  };
}

/** taskMask from leaf indices. */
export function maskFromIndices(indices: number[]): bigint {
  let m = 0n;
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= MAX_TASKS) throw new Error(`mask: bad index ${i}`);
    m |= 1n << BigInt(i);
  }
  return m;
}

/** Leaf indices set in `mask` (only bits < count considered; throws if higher bits are set). */
export function indicesFromMask(mask: bigint, count: number): number[] {
  if (mask < 0n) throw new Error('mask: negative');
  if (mask >> BigInt(count) !== 0n) throw new Error(`mask: bits set at or above taskCount ${count}`);
  const out: number[] = [];
  for (let i = 0; i < count; i++) if ((mask >> BigInt(i)) & 1n) out.push(i);
  return out;
}

export function popcount(mask: bigint): number {
  let n = 0;
  for (let m = mask; m > 0n; m >>= 1n) if (m & 1n) n++;
  return n;
}

/** Salts file kept privately by the seller (never delivered). */
export const saltsFileSchema = z.object({
  schemaVersion: z.literal('1'),
  environmentVersion: z.string().min(1),
  tasks: z.record(z.string(), z.string().regex(/^0x[0-9a-f]{64}$/)),
  audit: z.record(z.string(), z.string().regex(/^0x[0-9a-f]{64}$/)).optional(),
});
export type SaltsFile = z.infer<typeof saltsFileSchema>;

/** Juror vote commitment: keccak256(abi.encode(disputeId, round, uint8(verdict), salt, juror)). */
export function voteCommitment(args: {
  disputeId: bigint;
  round: number | bigint;
  verdict: number;
  salt: Hex;
  juror: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes32, address'), [
      args.disputeId,
      Number(args.round),
      args.verdict,
      normalizeBytes32(args.salt, 'salt'),
      args.juror,
    ]),
  );
}
