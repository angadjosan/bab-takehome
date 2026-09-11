import * as fs from 'node:fs';
import * as path from 'node:path';
import { concat, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_DOMAIN,
  auditLeaf,
  buildTaskTree,
  encodeLeafPayload,
  hashPair,
  indicesFromMask,
  maskFromIndices,
  merkleProof,
  merkleRoot,
  popcount,
  randomSalt,
  sha256Hex,
  taskHashInPayload,
  taskLeaf,
  verifyMerkleProof,
  voteCommitment,
} from '../src/index.ts';
import { cast, hasCast, tmp } from './helpers.ts';

const vec = {
  environmentVersion: 'py-repair-kit@1.0.0',
  taskId: 't01',
  taskHash: sha256Hex('task-bytes'),
  graderDigest: sha256Hex('grader-bytes'),
  salt: ('0x' + '11'.repeat(32)) as Hex,
};

describe('task leaf', () => {
  it.skipIf(!hasCast)('abi.encode + keccak matches cast (Solidity-equivalent)', () => {
    const sig = 'f(string,string,string,bytes32,bytes32,bytes32)';
    const encoded = cast('abi-encode', sig, 'envmarket.task.v1', vec.environmentVersion, vec.taskId, vec.taskHash, vec.graderDigest, vec.salt);
    expect(encodeLeafPayload(vec)).toBe(encoded);
    expect(taskLeaf(vec)).toBe(cast('keccak', encoded));

    const encodedAudit = cast('abi-encode', sig, AUDIT_DOMAIN, vec.environmentVersion, vec.taskId, vec.taskHash, vec.graderDigest, vec.salt);
    expect(auditLeaf(vec)).toBe(cast('keccak', encodedAudit));
    expect(auditLeaf(vec)).not.toBe(taskLeaf(vec));
  });

  it.skipIf(!hasCast)('vote commitment matches cast', () => {
    const juror = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const salt = ('0x' + 'ab'.repeat(32)) as Hex;
    const encoded = cast('abi-encode', 'f(uint256,uint8,uint8,bytes32,address)', '7', '1', '2', salt, juror);
    expect(voteCommitment({ disputeId: 7n, round: 1, verdict: 2, salt, juror })).toBe(cast('keccak', encoded));
  });

  it('salt changes the leaf; salts are random 32 bytes', () => {
    const s1 = randomSalt();
    const s2 = randomSalt();
    expect(s1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s1).not.toBe(s2);
    expect(taskLeaf({ ...vec, salt: s1 })).not.toBe(taskLeaf({ ...vec, salt: s2 }));
  });

  it('taskHash is the canonical tar of tasks/<id>/ (relative to the task dir)', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'tasks/t01/tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks/t01/task.json'), '{}');
    fs.writeFileSync(path.join(root, 'tasks/t01/tests/test_a.py'), 'assert 1\n');
    const other = tmp();
    fs.cpSync(path.join(root, 'tasks/t01'), path.join(other, 'elsewhere'), { recursive: true });
    expect(taskHashInPayload(root, 't01')).toMatch(/^0x[0-9a-f]{64}$/);
    // location-independent: same bytes wherever the task dir lives (audit tasks live elsewhere)
    expect(taskHashInPayload(root, 't01')).toBe(
      (() => {
        fs.mkdirSync(path.join(other, 'tasks'), { recursive: true });
        fs.renameSync(path.join(other, 'elsewhere'), path.join(other, 'tasks', 't01'));
        return taskHashInPayload(other, 't01');
      })(),
    );
    expect(() => taskHashInPayload(root, '../x')).toThrow(/taskId/);
  });
});

describe('merkle (@openzeppelin/merkle-tree SimpleMerkleTree, caller-ordered leaves)', () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => keccak256(new Uint8Array([i])));

  it('hashPair is commutative keccak of sorted concat', () => {
    const [a, b] = leaves(2) as [Hex, Hex];
    const expected = keccak256(a < b ? concat([a, b]) : concat([b, a]));
    expect(hashPair(a, b)).toBe(expected);
    expect(hashPair(b, a)).toBe(expected);
  });

  it.skipIf(!hasCast)('hashPair matches cast keccak', () => {
    const [a, b] = leaves(2) as [Hex, Hex];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    expect(hashPair(a, b)).toBe(cast('keccak', lo + hi.slice(2)));
  });

  it('single leaf: root = leaf, empty proof', () => {
    const l = leaves(1);
    expect(merkleRoot(l)).toBe(l[0]);
    expect(merkleProof(l, 0)).toEqual([]);
    expect(verifyMerkleProof(l[0]!, [], l[0]!)).toBe(true);
  });

  it('three leaves', () => {
    const [a, b, c] = leaves(3) as [Hex, Hex, Hex];
    expect(merkleRoot([a, b, c])).toBe(hashPair(hashPair(a, b), c));
    expect(merkleProof([a, b, c], 2)).toEqual([hashPair(a, b)]);
  });

  it('OZ complete-tree layout (differs from "promote the odd node" for n = 5, 7, ...); pinned roots', () => {
    const [a, b, c, d, e] = leaves(5) as [Hex, Hex, Hex, Hex, Hex];
    // OZ: root = H(H(H(a,b), e), H(c,d)); the old promote-odd tree gave H(H(H(a,b), H(c,d)), e).
    expect(merkleRoot([a, b, c, d, e])).toBe(hashPair(hashPair(hashPair(a, b), e), hashPair(c, d)));
    expect(merkleProof([a, b, c, d, e], 4)).toEqual([hashPair(a, b), hashPair(c, d)]);
    expect(merkleRoot(leaves(4))).toBe('0xfecce4ac8ed6fc57f4d880d6af2b443418d564df8f5d52c6782e952564ed79eb');
    expect(merkleRoot(leaves(5))).toBe('0x4012e3527351abde51ed075bbd7c41097ede613e3e77bc14c1b2900fee859002');
    expect(merkleRoot(leaves(7))).toBe('0x0af28ae5cb5b59d9695a4c6315dec300addb43ae2993325da6d7a17719680da3');
    // leaves are NOT re-sorted: order matters (index == taskMask bit)
    expect(merkleRoot([...leaves(5)].reverse())).not.toBe(merkleRoot(leaves(5)));
  });

  it('every proof verifies for n = 1..17; tampering fails', () => {
    for (let n = 1; n <= 17; n++) {
      const l = leaves(n);
      const root = merkleRoot(l);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(l, i);
        expect(verifyMerkleProof(l[i]!, proof, root)).toBe(true);
        if (proof.length > 0) {
          const bad = [...proof];
          bad[0] = keccak256('0xbadbad');
          expect(verifyMerkleProof(l[i]!, bad, root)).toBe(false);
        }
        expect(verifyMerkleProof(keccak256('0xdead'), proof, root)).toBe(false);
      }
    }
  });

  it('buildTaskTree orders by taskId, index == mask bit, proofs verify', () => {
    const graderDigest = sha256Hex('g');
    const tasks = ['t03', 't01', 't05', 't02', 't04'].map((taskId) => ({ taskId, taskHash: sha256Hex(taskId), salt: randomSalt() }));
    const tree = buildTaskTree({ environmentVersion: '1.0.0', graderDigest, tasks });
    expect(tree.leaves.map((l) => l.taskId)).toEqual(['t01', 't02', 't03', 't04', 't05']);
    for (const l of tree.leaves) {
      expect(verifyMerkleProof(l.leaf, l.proof, tree.root)).toBe(true);
      expect(l.leaf).toBe(taskLeaf({ environmentVersion: '1.0.0', taskId: l.taskId, taskHash: l.taskHash, graderDigest, salt: l.salt }));
    }
    const audit = buildTaskTree({ environmentVersion: '1.0.0', graderDigest, tasks, domain: AUDIT_DOMAIN });
    expect(audit.root).not.toBe(tree.root);
    expect(() => buildTaskTree({ environmentVersion: '1', graderDigest, tasks: [...tasks, tasks[0]!] })).toThrow(/duplicate/);
  });

  it('masks', () => {
    const m = maskFromIndices([0, 2, 4]);
    expect(m).toBe(0b10101n);
    expect(indicesFromMask(m, 5)).toEqual([0, 2, 4]);
    expect(popcount(m)).toBe(3);
    expect(() => indicesFromMask(1n << 5n, 5)).toThrow();
  });
});
