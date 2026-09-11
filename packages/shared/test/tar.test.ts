import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import tarStream from 'tar-stream';
import { describe, expect, it } from 'vitest';
import {
  canonicalTarHashOfDir,
  canonicalTarOfDir,
  extractTar,
  readTar,
  sha256Hex,
  writeTar,
} from '../src/index.ts';
import { tmp, which } from './helpers.ts';

function makeTree(root: string, order: 'forward' | 'reverse' = 'forward') {
  const files: Array<[string, string, number]> = [
    ['manifest.json', '{"schemaVersion":"1"}', 0o644],
    ['src/pkg/__init__.py', '', 0o644],
    ['src/pkg/core.py', 'def f(x):\n    return x + 1\n', 0o644],
    ['tasks/t01/task.json', '{"id":"t01"}', 0o644],
    ['tasks/t01/tests/test_core.py', 'assert True\n', 0o644],
    ['grader/run.sh', '#!/bin/sh\nexit 0\n', 0o755],
    ['requirements.lock', 'pytest==8.3.3\n', 0o644],
    ['IMAGE_DIGEST', 'sha256:' + 'ab'.repeat(32) + '\n', 0o644],
  ];
  const list = order === 'forward' ? files : [...files].reverse();
  for (const [p, content, mode] of list) {
    const abs = path.join(root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    fs.chmodSync(abs, mode);
  }
  fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
}

describe('canonical tar', () => {
  it('same content → same hash, independent of mtimes, creation order, and non-exec perms', () => {
    const a = tmp();
    const b = tmp();
    makeTree(a, 'forward');
    makeTree(b, 'reverse');
    // Perturb metadata in b: mtimes, read-only file perms, a .DS_Store and __pycache__ (default-excluded).
    for (const p of ['src/pkg/core.py', 'manifest.json', 'tasks/t01/task.json']) {
      fs.utimesSync(path.join(b, p), new Date(1_000_000_000_000), new Date(1_600_000_000_000));
      fs.chmodSync(path.join(b, p), 0o600);
    }
    fs.writeFileSync(path.join(b, '.DS_Store'), 'junk');
    fs.mkdirSync(path.join(b, 'src/pkg/__pycache__'));
    fs.writeFileSync(path.join(b, 'src/pkg/__pycache__/core.cpython-312.pyc'), 'junk');

    const h1 = canonicalTarHashOfDir(a);
    const h2 = canonicalTarHashOfDir(a);
    const h3 = canonicalTarHashOfDir(b);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);

    fs.writeFileSync(path.join(b, 'src/pkg/core.py'), 'def f(x):\n    return x + 2\n');
    expect(canonicalTarHashOfDir(b)).not.toBe(h1);
  });

  it('executable bit changes the hash (0755 vs 0644)', () => {
    const a = tmp();
    makeTree(a);
    const h = canonicalTarHashOfDir(a);
    fs.chmodSync(path.join(a, 'grader/run.sh'), 0o644);
    expect(canonicalTarHashOfDir(a)).not.toBe(h);
  });

  it('header fields are canonical and entries sorted with dirs included', () => {
    const a = tmp();
    makeTree(a);
    const tar = canonicalTarOfDir(a);
    expect(tar.length % 512).toBe(0);
    const entries = readTar(tar);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('src');
    expect(paths).toContain('src/pkg');
    expect(paths).toContain('empty-dir');
    expect(entries.find((e) => e.path === 'src')!.mode).toBe(0o755);
    expect(entries.find((e) => e.path === 'grader/run.sh')!.mode).toBe(0o755);
    expect(entries.find((e) => e.path === 'manifest.json')!.mode).toBe(0o644);
    // first header (tar-stream encoding): mtime/uid/gid are zero, uname/gname empty, magic "ustar" NUL "00"
    const h = tar.subarray(0, 512);
    const txt = (o: number, n: number) => Buffer.from(h.subarray(o, o + n)).toString('latin1');
    const NUL = String.fromCharCode(0);
    expect(txt(108, 8)).toBe('000000 ' + NUL);
    expect(txt(116, 8)).toBe('000000 ' + NUL);
    expect(txt(136, 12)).toBe('00000000000 ');
    expect(txt(257, 8)).toBe('ustar\u000000');
    expect(h.subarray(265, 329).every((x) => x === 0)).toBe(true);
  });

  const enc = new TextEncoder();
  const NL = String.fromCharCode(10);
  const LONG = 'deep/' + 'd'.repeat(60) + '/' + 'e'.repeat(60) + '/f.txt';
  const vectorInputs = () => [
    { path: 'run.sh', type: 'file' as const, data: enc.encode('#!/bin/sh' + NL + 'exit 0' + NL), executable: true },
    { path: 'a/b.txt', type: 'file' as const, data: enc.encode('hello' + NL) },
    { path: 'empty', type: 'dir' as const },
    { path: LONG, type: 'file' as const, data: enc.encode('long') },
  ];

  it('pinned vector (tar-stream header codec; changed from the hand-rolled writer)', () => {
    const t = writeTar(vectorInputs());
    expect(t.length).toBe(6656);
    expect(sha256Hex(t)).toBe('0x684f08f699818922246eff6e27f63b7b2cbd02779a7bada7c78b6d1911976a68');
  });

  it("is byte-identical to tar-stream's own pack() and readable by its extract()", async () => {
    const t = writeTar(vectorInputs());
    const entries = readTar(t);
    const p = tarStream.pack();
    const chunks: Buffer[] = [];
    p.on('data', (c: unknown) => chunks.push(c as Buffer));
    const done = new Promise<void>((r) => p.on('end', () => r()));
    for (const e of entries) {
      const header = { name: e.type === 'dir' ? `${e.path}/` : e.path, type: e.type === 'dir' ? 'directory' : 'file', mode: e.mode, mtime: new Date(0), uid: 0, gid: 0, uname: '', gname: '' } as const;
      if (e.type === 'dir') p.entry(header);
      else p.entry({ ...header, size: e.data.length }, Buffer.from(e.data));
    }
    p.finalize();
    await done;
    expect(sha256Hex(new Uint8Array(Buffer.concat(chunks)))).toBe(sha256Hex(t));

    const x = tarStream.extract();
    const seen: Array<[string, string, number]> = [];
    x.on('entry', (hdr, stream, next) => {
      seen.push([hdr.name, hdr.type ?? '', hdr.mode ?? 0]);
      stream.on('end', next);
      stream.resume();
    });
    const finished = new Promise<void>((r) => x.on('finish', () => r()));
    x.end(Buffer.from(t));
    await finished;
    expect(seen.map((s) => s[0])).toContain(LONG);
    expect(seen.find((s) => s[0] === 'run.sh')).toEqual(['run.sh', 'file', 0o755]);
    expect(seen.find((s) => s[0] === 'empty/')?.[1]).toBe('directory');
  });

  it('rejects non-ASCII paths (plain ustar, no PAX)', () => {
    expect(() => writeTar([{ path: 'caf' + String.fromCharCode(0xe9) + '.txt', type: 'file', data: new Uint8Array() }])).toThrow(/non-ASCII/);
  });

  it('exclude option (paths and subtrees)', () => {
    const a = tmp();
    makeTree(a);
    const withoutManifest = readTar(canonicalTarOfDir(a, { exclude: ['manifest.json', 'tasks'] })).map((e) => e.path);
    expect(withoutManifest).not.toContain('manifest.json');
    expect(withoutManifest.some((p) => p.startsWith('tasks'))).toBe(false);
    expect(withoutManifest).toContain('src/pkg/core.py');
  });

  it('writeTar adds implied parents; in-memory == on-disk', () => {
    const a = tmp();
    fs.mkdirSync(path.join(a, 'x/y'), { recursive: true });
    fs.writeFileSync(path.join(a, 'x/y/z.txt'), 'hi');
    const mem = writeTar([{ path: 'x/y/z.txt', type: 'file', data: new TextEncoder().encode('hi') }]);
    expect(sha256Hex(mem)).toBe(canonicalTarHashOfDir(a));
  });

  it('extract round trip reproduces the same canonical hash, including long paths', () => {
    const a = tmp();
    makeTree(a);
    const long = 'deep/' + 'd'.repeat(60) + '/' + 'e'.repeat(60) + '/file-with-a-long-name.txt';
    fs.mkdirSync(path.join(a, path.dirname(long)), { recursive: true });
    fs.writeFileSync(path.join(a, long), 'long');
    const tar = canonicalTarOfDir(a);
    const out = path.join(tmp(), 'out');
    extractTar(tar, out);
    expect(fs.readFileSync(path.join(out, long), 'utf8')).toBe('long');
    expect(fs.statSync(path.join(out, 'grader/run.sh')).mode & 0o777).toBe(0o755);
    expect(canonicalTarHashOfDir(out)).toBe(sha256Hex(tar));
  });

  it.skipIf(!which('tar'))('system tar can list and extract the archive identically', () => {
    const a = tmp();
    makeTree(a);
    const tarPath = path.join(tmp(), 'a.tar');
    fs.writeFileSync(tarPath, canonicalTarOfDir(a));
    const listing = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).trim().split('\n');
    expect(listing).toContain('src/pkg/core.py');
    expect(listing).toContain('empty-dir/');
    const out = tmp();
    execFileSync('tar', ['-xf', tarPath, '-C', out]);
    expect(canonicalTarHashOfDir(out)).toBe(canonicalTarHashOfDir(a));
  });

  it.skipIf(!which('python3'))('python tarfile parses it as ustar with canonical metadata', () => {
    const a = tmp();
    makeTree(a);
    const tarPath = path.join(tmp(), 'a.tar');
    fs.writeFileSync(tarPath, canonicalTarOfDir(a));
    const py = `import tarfile,json,sys
t=tarfile.open(sys.argv[1],format=tarfile.USTAR_FORMAT)
print(json.dumps([[m.name,m.mode,m.mtime,m.uid,m.gid,m.uname,m.gname,m.type.decode()] for m in t.getmembers()]))`;
    const rows = JSON.parse(execFileSync('python3', ['-c', py, tarPath], { encoding: 'utf8' })) as unknown[][];
    for (const [, , mtime, uid, gid, uname, gname] of rows) {
      expect([mtime, uid, gid, uname, gname]).toEqual([0, 0, 0, '', '']);
    }
    expect(rows.find((r) => r[0] === 'grader/run.sh')![1]).toBe(0o755);
  });
});

function tamperName(tar: Uint8Array, newName: string, typeflag?: string): Uint8Array {
  const t = new Uint8Array(tar);
  const h = t.subarray(0, 512);
  h.fill(0, 0, 100);
  h.set(new TextEncoder().encode(newName), 0);
  if (typeflag) h[156] = typeflag.charCodeAt(0);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  const cs = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) h[148 + i] = cs.charCodeAt(i);
  h[154] = 0;
  h[155] = 0x20;
  return t;
}

describe('safe reader/extractor', () => {
  const base = writeTar([{ path: 'a.txt', type: 'file', data: new TextEncoder().encode('x') }]);

  it('rejects path traversal and absolute paths', () => {
    expect(() => readTar(tamperName(base, '../evil.txt'))).toThrow(/unsafe/);
    expect(() => readTar(tamperName(base, 'ok/../../evil.txt'))).toThrow(/unsafe/);
    expect(() => readTar(tamperName(base, '/etc/passwd'))).toThrow(/absolute/);
    expect(() => extractTar(tamperName(base, '../evil.txt'), tmp())).toThrow();
  });

  it('rejects symlinks, hardlinks and PAX headers', () => {
    expect(() => readTar(tamperName(base, 'link', '2'))).toThrow(/link/);
    expect(() => readTar(tamperName(base, 'link', '1'))).toThrow(/link/);
    expect(() => readTar(tamperName(base, 'pax', 'x'))).toThrow(/extension/);
  });

  it('rejects bad checksums and truncated archives', () => {
    const bad = new Uint8Array(base);
    bad[0] = 'b'.charCodeAt(0);
    expect(() => readTar(bad)).toThrow(/checksum/);
    expect(() => readTar(base.subarray(0, 512))).toThrow(/truncated|end-of-archive/);
  });

  it('refuses non-empty destination and symlinks in source dirs', () => {
    const dest = tmp();
    fs.writeFileSync(path.join(dest, 'existing'), '1');
    expect(() => extractTar(base, dest)).toThrow(/not empty/);
    const src = tmp();
    fs.writeFileSync(path.join(src, 'f'), '1');
    fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
    expect(() => canonicalTarOfDir(src)).toThrow(/symlink/);
  });
});
