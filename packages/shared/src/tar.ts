/**
 * Deterministic POSIX ustar writer + safe reader/extractor.
 *
 * Canonical form (BUILD_SPEC "Canonical archive"):
 * - entries sorted by path (byte-wise over UTF-8, path without trailing slash); parent
 *   directories are always present (implied parents are added automatically);
 * - regular files (typeflag '0') and directories (typeflag '5', name ends with '/') only;
 * - mtime 0, uid/gid 0, uname/gname "", devmajor/devminor 0, linkname empty;
 * - mode 0644 for files, 0755 for directories and for files with any executable bit;
 * - names > 100 bytes are split into the ustar `prefix` field at a '/'; no PAX/GNU extensions,
 *   so paths must be ASCII;
 * - archive ends with two zero blocks; no padding to a 10240-byte record; no compression.
 *
 * Header serialization and parsing is tar-stream's ustar codec (`tar-stream/headers.js`, the code
 * behind its pack()/extract() streams, which are async-only). We keep the framing, normalization
 * and safety policy; a test pins that `writeTar` output is byte-identical to tar-stream's pack().
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Hex } from 'viem';
import { sha256Hex, utf8 } from './hash.ts';

const BLOCK = 512;

interface TarStreamHeader {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: Date;
  type: string | null;
  linkname?: string | null;
  uname?: string;
  gname?: string;
  devmajor?: number;
  devminor?: number;
}

/** tar-stream's ustar header codec. Not in its package `exports`, so it is loaded by file path. */
const tarHeaders: {
  encode(h: TarStreamHeader): Buffer | null;
  decode(buf: Buffer, filenameEncoding?: string, allowUnknownFormat?: boolean): TarStreamHeader | null;
} = (() => {
  const req = createRequire(import.meta.url);
  return req(path.join(path.dirname(req.resolve('tar-stream')), 'headers.js'));
})();

export type TarEntryType = 'file' | 'dir';

/** An entry to write. `data` is required for files; `executable` selects mode 0755. */
export interface TarInput {
  path: string;
  type: TarEntryType;
  data?: Uint8Array;
  executable?: boolean;
}

/** An entry read back from an archive. */
export interface TarEntry {
  path: string;
  type: TarEntryType;
  mode: number;
  data: Uint8Array; // empty for directories
}

/**
 * Validate and normalize a relative archive path: '/' separators, no leading '/', no '\\',
 * no NUL, no empty / '.' / '..' segments. A single trailing '/' is stripped.
 */
export function normalizeTarPath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('tar: empty path');
  if (p.includes('\0')) throw new Error(`tar: NUL in path ${JSON.stringify(p)}`);
  if (p.includes('\\')) throw new Error(`tar: backslash in path ${JSON.stringify(p)}`);
  if (p.startsWith('/')) throw new Error(`tar: absolute path rejected: ${JSON.stringify(p)}`);
  if (/^[A-Za-z]:/.test(p)) throw new Error(`tar: drive-letter path rejected: ${JSON.stringify(p)}`);
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const segs = trimmed.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') {
      throw new Error(`tar: unsafe path rejected: ${JSON.stringify(p)}`);
    }
  }
  return trimmed;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Canonical ustar header via tar-stream (mtime 0, uid/gid 0, empty uname/gname, dev 0/0). */
function buildHeader(entryName: string, type: TarEntryType, mode: number, size: number): Uint8Array {
  if (utf8(entryName).length !== entryName.length) {
    throw new Error(`tar: non-ASCII path not representable in plain ustar: ${JSON.stringify(entryName)}`);
  }
  const h = tarHeaders.encode({
    name: entryName,
    type: type === 'dir' ? 'directory' : 'file',
    mode,
    uid: 0,
    gid: 0,
    size,
    mtime: new Date(0),
    uname: '',
    gname: '',
    devmajor: 0,
    devminor: 0,
  });
  if (!h) throw new Error(`tar: path too long for ustar (${entryName.length} bytes): ${entryName}`);
  return new Uint8Array(h.buffer, h.byteOffset, BLOCK);
}

/** Write a deterministic ustar archive. Input order is irrelevant; implied parent dirs are added. */
export function writeTar(inputs: TarInput[]): Uint8Array {
  const map = new Map<string, { type: TarEntryType; data: Uint8Array; mode: number }>();
  for (const e of inputs) {
    const p = normalizeTarPath(e.path);
    if (map.has(p)) {
      const prev = map.get(p)!;
      if (!(prev.type === 'dir' && e.type === 'dir')) throw new Error(`tar: duplicate entry ${p}`);
      continue;
    }
    if (e.type === 'file') {
      if (!(e.data instanceof Uint8Array)) throw new Error(`tar: file ${p} has no data`);
      map.set(p, { type: 'file', data: e.data, mode: e.executable ? 0o755 : 0o644 });
    } else if (e.type === 'dir') {
      map.set(p, { type: 'dir', data: new Uint8Array(0), mode: 0o755 });
    } else {
      throw new Error(`tar: unsupported entry type for ${p}`);
    }
  }
  // Add implied parent directories; reject files used as directories.
  for (const p of [...map.keys()]) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      const existing = map.get(parent);
      if (existing && existing.type !== 'dir') throw new Error(`tar: ${parent} is both a file and a directory`);
      if (!existing) map.set(parent, { type: 'dir', data: new Uint8Array(0), mode: 0o755 });
    }
  }
  const sorted = [...map.entries()]
    .map(([p, v]) => ({ p, key: utf8(p), ...v }))
    .sort((a, b) => compareBytes(a.key, b.key));

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const e of sorted) {
    const name = e.type === 'dir' ? e.p + '/' : e.p;
    const header = buildHeader(name, e.type, e.mode, e.data.length);
    chunks.push(header);
    total += BLOCK;
    if (e.type === 'file' && e.data.length > 0) {
      const padded = Math.ceil(e.data.length / BLOCK) * BLOCK;
      const body = new Uint8Array(padded);
      body.set(e.data, 0);
      chunks.push(body);
      total += padded;
    }
  }
  total += 2 * BLOCK; // end-of-archive marker
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const USTAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00]; // "ustar\0"

/**
 * Parse a ustar archive fully in memory (headers decoded by tar-stream). Rejects: bad checksums,
 * non-ustar (incl. GNU) headers, symlinks/hardlinks/devices/fifos, PAX/GNU extension headers,
 * absolute or '..' paths, duplicate paths, truncated data, missing end-of-archive marker.
 */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  let ended = false;
  while (off + BLOCK <= bytes.length) {
    const h = bytes.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!USTAR_MAGIC.every((b, i) => h[257 + i] === b)) throw new Error(`tar: not a ustar header at offset ${off}`);
    let hdr: TarStreamHeader | null;
    try {
      hdr = tarHeaders.decode(Buffer.from(h.buffer, h.byteOffset, BLOCK), 'utf-8', false);
    } catch {
      throw new Error(`tar: checksum mismatch at offset ${off}`);
    }
    if (!hdr) throw new Error(`tar: empty header with non-zero checksum at offset ${off}`);

    const rawPath = hdr.name;
    const flag = String.fromCharCode(h[156]!);
    const size = hdr.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: invalid size for ${rawPath}`);
    const mode = hdr.mode & 0o7777;

    let type: TarEntryType;
    switch (hdr.type) {
      case 'file':
      case 'contiguous-file':
        type = 'file';
        break;
      case 'directory':
        type = 'dir';
        break;
      case 'link':
      case 'symlink':
        throw new Error(`tar: link entry rejected: ${rawPath}`);
      case 'pax-header':
      case 'pax-global-header':
      case 'gnu-long-path':
      case 'gnu-long-link-path':
        throw new Error(`tar: extension header '${flag}' not supported (${rawPath})`);
      default:
        throw new Error(`tar: unsupported entry type '${flag}' for ${rawPath}`);
    }

    const p = normalizeTarPath(rawPath);
    if (seen.has(p)) throw new Error(`tar: duplicate entry ${p}`);
    seen.add(p);

    const dataStart = off + BLOCK;
    const dataSize = type === 'dir' ? 0 : size;
    if (dataStart + dataSize > bytes.length) throw new Error(`tar: truncated data for ${p}`);
    const data = bytes.slice(dataStart, dataStart + dataSize);
    entries.push({ path: p, type, mode, data });
    off = dataStart + Math.ceil(dataSize / BLOCK) * BLOCK;
  }
  if (!ended) throw new Error('tar: missing end-of-archive marker (truncated archive)');
  // Files must not sit where a directory path is required.
  const types = new Map(entries.map((e) => [e.path, e.type] as const));
  for (const e of entries) {
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      if (types.get(parent) === 'file') throw new Error(`tar: ${parent} is both a file and a directory`);
    }
  }
  return entries;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const rel = path.relative(root, target);
  let cur = root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // does not exist yet; nothing below it exists either
    }
    if (st.isSymbolicLink()) throw new Error(`tar: refusing to extract through symlink ${cur}`);
  }
}

export interface ExtractOptions {
  /** Allow extracting into a non-empty directory (existing files are never overwritten). */
  allowNonEmpty?: boolean;
  /**
   * Permission bits for `destDir` itself (e.g. 0o700 for plaintext that other uids must not reach).
   * Applied with an explicit chmod, so the umask cannot widen or narrow it, and whether or not the
   * directory already existed. Default: unchanged (created per the umask, existing mode kept).
   */
  mode?: number;
}

/**
 * Safely extract an archive into `destDir`. The whole archive is validated before anything is
 * written. By default `destDir` must be absent or empty. Existing files are never overwritten
 * and symlinked path components are refused. Returns the extracted paths (archive order).
 */
export function extractTar(bytes: Uint8Array, destDir: string, opts: ExtractOptions = {}): string[] {
  const entries = readTar(bytes);
  fs.mkdirSync(destDir, { recursive: true, ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
  if (!fs.statSync(destDir).isDirectory()) throw new Error(`tar: ${destDir} is not a directory`);
  // before any entry is written, so plaintext never sits in a directory with the wrong mode
  if (opts.mode !== undefined) fs.chmodSync(destDir, opts.mode);
  if (!opts.allowNonEmpty && fs.readdirSync(destDir).length > 0) {
    throw new Error(`tar: destination ${destDir} is not empty`);
  }
  const root = fs.realpathSync(destDir);
  for (const e of entries) {
    const target = path.resolve(root, ...e.path.split('/'));
    const rel = path.relative(root, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`tar: entry escapes destination: ${e.path}`);
    }
    assertNoSymlinkComponents(root, target);
    if (e.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
      fs.chmodSync(target, 0o755);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const mode = (e.mode & 0o111) !== 0 ? 0o755 : 0o644;
      fs.writeFileSync(target, e.data, { flag: 'wx', mode });
      fs.chmodSync(target, mode);
    }
  }
  return entries.map((e) => e.path);
}

/** Basenames excluded by default when archiving a directory (never part of a payload). */
export const DEFAULT_EXCLUDE_NAMES: readonly string[] = [
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.git',
];

export interface DirTarOptions {
  /**
   * Relative paths (POSIX, relative to the root) to exclude; a directory excludes its subtree.
   * RegExps are tested against the relative path. A function returning true excludes.
   */
  exclude?: Array<string | RegExp> | ((relPath: string, isDir: boolean) => boolean);
  /** Basenames excluded anywhere in the tree. Defaults to DEFAULT_EXCLUDE_NAMES; pass [] to disable. */
  excludeNames?: readonly string[];
}

function isExcluded(rel: string, name: string, isDir: boolean, opts: DirTarOptions): boolean {
  const names = opts.excludeNames ?? DEFAULT_EXCLUDE_NAMES;
  if (names.includes(name)) return true;
  const ex = opts.exclude;
  if (!ex) return false;
  if (typeof ex === 'function') return ex(rel, isDir);
  for (const x of ex) {
    if (typeof x === 'string') {
      const n = x.replace(/^\.\//, '').replace(/\/+$/, '');
      if (rel === n || rel.startsWith(n + '/')) return true;
    } else if (x.test(rel)) return true;
  }
  return false;
}

/**
 * Collect tar inputs for a directory tree (paths relative to `root`, root itself not included).
 * Symlinks and special files are rejected. File contents are read; fs mtimes/owners are ignored.
 */
export function tarEntriesOfDir(root: string, opts: DirTarOptions = {}): TarInput[] {
  const st = fs.statSync(root);
  if (!st.isDirectory()) throw new Error(`tar: ${root} is not a directory`);
  const out: TarInput[] = [];
  const walk = (absDir: string, relDir: string): void => {
    const names = fs.readdirSync(absDir).sort();
    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        if (isExcluded(rel, name, false, opts)) continue;
        throw new Error(`tar: symlink not allowed in payload: ${rel}`);
      }
      const isDir = lst.isDirectory();
      if (isExcluded(rel, name, isDir, opts)) continue;
      if (isDir) {
        out.push({ path: rel, type: 'dir' });
        walk(abs, rel);
      } else if (lst.isFile()) {
        out.push({
          path: rel,
          type: 'file',
          data: new Uint8Array(fs.readFileSync(abs)),
          executable: (lst.mode & 0o111) !== 0,
        });
      } else {
        throw new Error(`tar: special file not allowed in payload: ${rel}`);
      }
    }
  };
  walk(root, '');
  return out;
}

/** Deterministic canonical ustar archive of a directory (see module doc). */
export function canonicalTarOfDir(dir: string, opts: DirTarOptions = {}): Uint8Array {
  return writeTar(tarEntriesOfDir(dir, opts));
}

/** sha256 (bytes32 hex) of `canonicalTarOfDir(dir, opts)`. */
export function canonicalTarHashOfDir(dir: string, opts: DirTarOptions = {}): Hex {
  return sha256Hex(canonicalTarOfDir(dir, opts));
}
