/**
 * Deterministic POSIX ustar writer + safe reader/extractor.
 *
 * Canonical form (BUILD_SPEC "Canonical archive"):
 * - entries sorted by path (byte-wise over UTF-8, path without trailing slash); parent
 *   directories are always present (implied parents are added automatically);
 * - regular files (typeflag '0') and directories (typeflag '5', name ends with '/') only;
 * - mtime 0, uid/gid 0, uname/gname "", devmajor/devminor 0, linkname empty;
 * - mode 0644 for files, 0755 for directories and for files with any executable bit;
 * - names > 100 bytes are split into the ustar `prefix` field at a '/'; no PAX/GNU extensions;
 * - archive ends with two zero blocks; no padding to a 10240-byte record; no compression.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hex } from 'viem';
import { fromUtf8, sha256Hex, utf8 } from './hash.ts';

const BLOCK = 512;

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

function writeOctal(h: Uint8Array, off: number, len: number, value: number): void {
  const s = value.toString(8).padStart(len - 1, '0');
  if (s.length > len - 1) throw new Error(`tar: numeric field overflow (${value})`);
  for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  h[off + len - 1] = 0;
}

function writeAscii(h: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
}

function splitName(name: Uint8Array): { name: Uint8Array; prefix: Uint8Array } {
  if (name.length <= 100) return { name, prefix: new Uint8Array(0) };
  // Split at a '/' so that prefix <= 155 bytes and name <= 100 bytes (name non-empty).
  for (let i = Math.min(155, name.length - 2); i > 0; i--) {
    if (name[i] === 0x2f) {
      const prefix = name.subarray(0, i);
      const rest = name.subarray(i + 1);
      if (rest.length > 0 && rest.length <= 100) return { name: rest, prefix };
    }
  }
  throw new Error(`tar: path too long for ustar (${name.length} bytes): ${fromUtf8(name)}`);
}

function buildHeader(entryName: string, type: TarEntryType, mode: number, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(utf8(entryName));
  h.set(name, 0); // name[100]
  writeOctal(h, 100, 8, mode); // mode
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, size); // size
  writeOctal(h, 136, 12, 0); // mtime
  h.fill(0x20, 148, 156); // chksum placeholder (8 spaces)
  h[156] = type === 'dir' ? 0x35 : 0x30; // typeflag
  // linkname[100] at 157: zeros
  writeAscii(h, 257, 'ustar\0'); // magic
  writeAscii(h, 263, '00'); // version
  // uname[32] at 265, gname[32] at 297: empty
  writeOctal(h, 329, 8, 0); // devmajor
  writeOctal(h, 337, 8, 0); // devminor
  h.set(prefix, 345); // prefix[155]
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  const cs = sum.toString(8).padStart(6, '0');
  writeAscii(h, 148, cs);
  h[154] = 0;
  h[155] = 0x20;
  return h;
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

function readCString(h: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && h[end] !== 0) end++;
  return fromUtf8(h.subarray(off, end));
}

function parseOctal(h: Uint8Array, off: number, len: number, field: string): number {
  if ((h[off]! & 0x80) !== 0) throw new Error(`tar: base-256 ${field} not supported`);
  const s = readCString(h, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar: invalid octal in ${field}: ${JSON.stringify(s)}`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new Error(`tar: ${field} too large`);
  return n;
}

/**
 * Parse a ustar archive fully in memory. Rejects: bad checksums, non-ustar headers,
 * symlinks/hardlinks/devices/fifos, PAX/GNU extension headers, absolute or '..' paths,
 * duplicate paths, truncated data, missing end-of-archive marker.
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
    const stored = parseOctal(h, 148, 8, 'chksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw new Error(`tar: checksum mismatch at offset ${off}`);
    const magic = fromUtf8(h.subarray(257, 262));
    if (magic !== 'ustar') throw new Error(`tar: not a ustar header at offset ${off}`);

    const name = readCString(h, 0, 100);
    const prefix = readCString(h, 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const flag = String.fromCharCode(h[156]!);
    const size = parseOctal(h, 124, 12, 'size');
    const mode = parseOctal(h, 100, 8, 'mode') & 0o7777;

    let type: TarEntryType;
    if (flag === '0' || flag === '\0' || flag === '7') type = 'file';
    else if (flag === '5') type = 'dir';
    else if (flag === '1' || flag === '2') throw new Error(`tar: link entry rejected: ${rawPath}`);
    else if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      throw new Error(`tar: extension header '${flag}' not supported (${rawPath})`);
    } else throw new Error(`tar: unsupported entry type '${flag}' for ${rawPath}`);

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
}

/**
 * Safely extract an archive into `destDir`. The whole archive is validated before anything is
 * written. By default `destDir` must be absent or empty. Existing files are never overwritten
 * and symlinked path components are refused. Returns the extracted paths (archive order).
 */
export function extractTar(bytes: Uint8Array, destDir: string, opts: ExtractOptions = {}): string[] {
  const entries = readTar(bytes);
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.statSync(destDir).isDirectory()) throw new Error(`tar: ${destDir} is not a directory`);
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
