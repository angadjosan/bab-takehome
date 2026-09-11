/**
 * Execution sandbox for seller code (grader, hidden tests, agent-edited workspaces).
 *
 * Modes (chosen by `detectSandbox`, recorded truthfully in reports):
 *  - docker   (macOS / any host with Docker, not root-in-TEE): one container per phase:
 *      docker run --rm -i --network none --read-only --tmpfs /tmp --tmpfs /work --cpus 1
 *        --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL
 *        --user <uid> -v <dirs> python:3.12-slim@sha256:<digest> …
 *  - linux-root (inside the EigenCompute container, which runs as root):
 *      [unshare --net --pid --fork --mount-proc]   (when the kernel lets us; else omitted)
 *      setpriv --reuid <uid> --regid <uid> --clear-groups --no-new-privs
 *      prlimit --as --nproc --nofile --fsize --cpu
 *      python3 runtime/netdeny.py  (seccomp: no AF_INET/AF_INET6/… sockets, no io_uring)
 *      <venv>/bin/python …
 *    Every phase gets its own unprivileged uid; directories are chowned to it with 0700, so
 *    code run in one episode cannot read another episode's files or the service's data dir.
 *
 * Dependencies: `prepareVenv` installs the bundle's requirements.lock (binary wheels only) into
 * a cached venv *with* network, before any seller code runs; all later phases run offline.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@envmarket/shared';
import { errMsg, logger } from './log.ts';

export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
export const NETDENY = path.join(RUNTIME_DIR, 'netdeny.py');
/** python:3.12-slim multi-arch index digest (2026-09-01 build, 3.12.14-slim-trixie). */
export const DEFAULT_PY_IMAGE = 'python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea';

export interface SandboxInfo {
  kind: 'docker' | 'linux-root';
  image: string | null;
  unshareNet: boolean;
  seccompNetDeny: boolean;
  description: string;
}

export interface RunOptions {
  /** python argv after the interpreter, e.g. ['-m', 'grader.env'] */
  args: string[];
  cwd: string;
  /** host dirs the process may read (docker: bind-mounted read-only at the same path) */
  readDirs: string[];
  /** host dirs the process may write (owned by the phase uid) */
  writeDirs: string[];
  env?: Record<string, string>;
  timeoutSec: number;
  venv: string;
  uid: number;
  label: string;
  memoryMb?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function which(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

function dockerUsable(): boolean {
  return which('docker') && spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
}

export function detectSandbox(mode: 'auto' | 'docker' | 'unshare', image: string | null): SandboxInfo {
  const isLinuxRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
  const wantLinux = mode === 'unshare' || (mode === 'auto' && isLinuxRoot);
  if (wantLinux) {
    if (!isLinuxRoot) throw new Error('SANDBOX=unshare requires running as root on Linux');
    for (const b of ['setpriv', 'prlimit', 'python3']) if (!which(b)) throw new Error(`sandbox: ${b} not found`);
    const unshareNet = spawnSync('unshare', ['--net', '--pid', '--fork', '--mount-proc', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
    const probe = spawnSync('python3', [NETDENY, 'python3', '-c', 'import socket\ntry:\n socket.socket(socket.AF_INET)\n print("OPEN")\nexcept OSError:\n print("DENIED")'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const seccompNetDeny = probe.stdout?.trim() === 'DENIED';
    if (!unshareNet && !seccompNetDeny) throw new Error('sandbox: neither network namespaces nor seccomp net-deny are available; refusing to run seller code with network');
    const parts = [
      unshareNet ? 'unshare(net,pid)' : null,
      'setpriv(per-phase uid, no_new_privs)',
      'prlimit(as,nproc,nofile,fsize,cpu)',
      seccompNetDeny ? 'seccomp(no inet sockets, no io_uring)' : null,
      'wall-clock timeout',
    ].filter(Boolean);
    return {
      kind: 'linux-root',
      image: null,
      unshareNet,
      seccompNetDeny,
      description: `linux-root in-TEE runtime (python ${pyVersion('python3')}): ${parts.join(' + ')}`,
    };
  }
  if (!dockerUsable()) throw new Error('sandbox: docker not available (install/start Docker, or run as root on Linux)');
  const img = image ?? DEFAULT_PY_IMAGE;
  return {
    kind: 'docker',
    image: img,
    unshareNet: false,
    seccompNetDeny: false,
    description: `docker ${img} --network none --read-only --tmpfs /tmp --tmpfs /work --cpus 1 --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL, non-root uid`,
  };
}

function pyVersion(bin: string): string {
  const r = spawnSync(bin, ['-c', 'import platform;print(platform.python_version())'], { encoding: 'utf8' });
  return r.stdout?.trim() || 'unknown';
}

/** Give a directory tree to `uid` (linux-root) or make it writable for the container uid (docker). */
export function grantDir(info: SandboxInfo, dir: string, uid: number, writable: boolean): void {
  if (info.kind === 'linux-root') {
    spawnSync('chown', ['-R', `${uid}:${uid}`, dir]);
    spawnSync('chmod', ['-R', writable ? 'u+rwX,go-rwx' : 'u+rX,u-w,go-rwx', dir]);
  } else {
    spawnSync('chmod', ['-R', writable ? 'a+rwX' : 'a+rX', dir]);
  }
}

let runCounter = 0;

function buildCommand(info: SandboxInfo, o: RunOptions): { cmd: string; argv: string[]; name: string | null } {
  const py = path.join(o.venv, 'bin', 'python');
  const env = {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    LC_ALL: 'C.UTF-8',
    PATH: `${path.join(o.venv, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    ...(o.env ?? {}),
  };
  if (info.kind === 'docker') {
    const name = `envm-${process.pid}-${++runCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const argv = [
      'run', '--rm', '-i', '--name', name,
      '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,exec,size=128m', '--tmpfs', '/work:rw,exec,size=256m',
      '--cpus', '1', '--memory', `${o.memoryMb ?? 512}m`, '--pids-limit', '128',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
      '--user', `${o.uid}:${o.uid}`,
      '-w', o.cwd,
    ];
    const seen = new Set<string>();
    for (const d of o.writeDirs) if (!seen.has(d)) (seen.add(d), argv.push('-v', `${d}:${d}:rw`));
    for (const d of [...o.readDirs, o.venv]) if (!seen.has(d)) (seen.add(d), argv.push('-v', `${d}:${d}:ro`));
    for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
    argv.push(info.image!, py, ...o.args);
    return { cmd: 'docker', argv, name };
  }
  const cpu = Math.ceil(o.timeoutSec) + 5;
  const inner = [
    'setpriv', `--reuid=${o.uid}`, `--regid=${o.uid}`, '--clear-groups', '--no-new-privs',
    'prlimit', `--as=${(o.memoryMb ?? 1024) * 1024 * 1024 * 2}`, '--nproc=256', '--nofile=512', `--fsize=${64 * 1024 * 1024}`, `--cpu=${cpu}`, '--',
    ...(info.seccompNetDeny ? ['python3', NETDENY] : []),
    'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    py, ...o.args,
  ];
  const argv = info.unshareNet ? ['--net', '--pid', '--fork', '--mount-proc', '--', ...inner] : inner;
  return { cmd: info.unshareNet ? 'unshare' : argv.shift()!, argv, name: null };
}

/** Long-lived process (JSON-lines protocol over stdin/stdout). */
export function spawnSandboxed(info: SandboxInfo, o: RunOptions): { child: ChildProcess; kill: () => void } {
  const { cmd, argv, name } = buildCommand(info, o);
  const child = spawn(cmd, argv, { cwd: info.kind === 'docker' ? undefined : o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: info.kind === 'docker' ? process.env : {} });
  const kill = () => {
    if (name) spawnSync('docker', ['kill', name], { stdio: 'ignore', timeout: 15_000 });
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  return { child, kill };
}

/** One-shot run with a wall-clock timeout; output capped at 2 MB per stream. */
export function runSandboxed(info: SandboxInfo, o: RunOptions & { stdin?: string }): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const { child, kill } = spawnSandboxed(info, o);
    let stdout = '';
    let stderr = '';
    const cap = 2 * 1024 * 1024;
    child.stdout!.on('data', (d: Buffer) => (stdout.length < cap ? (stdout += d.toString()) : undefined));
    child.stderr!.on('data', (d: Buffer) => (stderr.length < cap ? (stderr += d.toString()) : undefined));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutSec * 1000 + (info.kind === 'docker' ? 15_000 : 0));
    child.on('error', (e) => {
      stderr += `\nspawn error: ${errMsg(e)}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - t0 });
    });
    if (o.stdin !== undefined) child.stdin!.end(o.stdin);
    else child.stdin!.end();
  });
}

/**
 * Create (or reuse) a venv with the bundle's pinned requirements. Runs WITH network but executes
 * no seller code: `pip install --only-binary=:all:` (+ `--require-hashes` when the lock has
 * hashes). Cached by sha256(runtime ‖ requirements.lock).
 */
export async function prepareVenv(info: SandboxInfo, cacheRoot: string, requirementsLock: string): Promise<{ venv: string; log: string; ok: boolean }> {
  const key = sha256Hex(`${info.kind}|${info.image ?? 'host'}|${requirementsLock}`).slice(2, 18);
  const venv = path.join(cacheRoot, `venv-${key}`);
  if (fs.existsSync(path.join(venv, '.ok'))) return { venv, log: 'cached', ok: true };
  fs.rmSync(venv, { recursive: true, force: true });
  fs.mkdirSync(venv, { recursive: true });
  const reqFile = path.join(venv, 'requirements.lock');
  fs.writeFileSync(reqFile, requirementsLock);
  const hashes = /--hash=sha256:/.test(requirementsLock) ? '--require-hashes' : '';
  const script = `set -e; python3 -m venv ${venv}; ${venv}/bin/pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: ${hashes} -r ${reqFile}`;
  let r: { status: number | null; stdout: string; stderr: string };
  if (info.kind === 'docker') {
    const out = spawnSync('docker', ['run', '--rm', '-v', `${venv}:${venv}:rw`, info.image!, 'sh', '-c', script], { encoding: 'utf8', timeout: 600_000 });
    r = { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  } else {
    const out = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 600_000 });
    r = { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  }
  const log = (r.stdout + '\n' + r.stderr).slice(-8000);
  if (r.status !== 0) {
    logger.warn('venv install failed', { venv, status: r.status });
    return { venv, log, ok: false };
  }
  spawnSync('chmod', ['-R', 'a+rX', venv]);
  fs.writeFileSync(path.join(venv, '.ok'), new Date().toISOString());
  return { venv, log, ok: true };
}

/** Allocate a fresh scratch dir for one phase. */
export function scratchDir(root: string, label: string): string {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${label.replace(/[^A-Za-z0-9_-]/g, '_')}-`));
}

let uidCounter = 0;
/** Distinct unprivileged uid per phase (linux-root); a fixed nobody-like uid under docker. */
export function nextUid(info: SandboxInfo): number {
  if (info.kind === 'docker') return 65534;
  uidCounter = (uidCounter + 1) % 20000;
  return 40000 + uidCounter;
}

export const HOST_TMP = os.tmpdir();
