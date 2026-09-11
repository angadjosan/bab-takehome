/**
 * IMAGE_DIGEST parsing. Accepts either a single immutable reference line
 * ("python:3.12-slim@sha256:<hex>") or key=value lines as written by the environment's
 * scripts/build-image.sh:
 *   image=sha256:<local image id>            (NOT reproducible across rebuilds)
 *   base=python:3.12-slim@sha256:<hex>       (registry digest: the committed imageDigest)
 *   dockerfile_sha256=<hex>
 * The committed imageDigest is the base image's registry digest; the runtime is that image plus
 * the hash-pinned requirements.lock (both inside the bundle).
 */
import type { Hex } from 'viem';

export interface ImageRef {
  /** Pullable immutable reference, e.g. python:3.12-slim@sha256:<hex> */
  ref: string;
  /** bytes32 form of the registry digest */
  digest: Hex;
  /** All key=value fields (empty for single-line format) */
  fields: Record<string, string>;
}

export function parseImageDigest(text: string): ImageRef {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const fields: Record<string, string> = {};
  for (const l of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (m) fields[m[1]!] = m[2]!.trim();
  }
  const candidate = fields.base ?? fields.ref ?? (Object.keys(fields).length === 0 ? lines[0] : undefined);
  const m = candidate ? /^[^\s@]+@sha256:([0-9a-f]{64})$/.exec(candidate) : null;
  if (!candidate || !m) {
    throw new Error(`IMAGE_DIGEST must name an immutable registry reference (<image>@sha256:<64 hex>, or base=<that>), got ${JSON.stringify(text.slice(0, 200))}`);
  }
  return { ref: candidate, digest: `0x${m[1]}` as Hex, fields };
}
