/**
 * Offline execution of a delivered environment on the buyer's machine.
 *
 * 1. prepare: install the bundle's hashed requirements.lock into a venv using the bundle's pinned
 *    image (IMAGE_DIGEST). This is the only step with network, and it runs `pip install
 *    --only-binary=:all: --require-hashes` (no seller code is executed).
 * 2. run: every command that executes seller code runs in `docker run --network none --read-only`
 *    with CPU/memory/pids limits, no capabilities, non-root uid, bundle mounted read-only.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from '@envmarket/shared';
import { parseImageDigest } from '../common/image.ts';

export interface Sandbox {
  image: string;
  envDir: string;
  venv: string;
  description: string;
}

export interface RunOut {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  argv: string[];
}

export function dockerAvailable(): boolean {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
}

export function prepareSandbox(envDir: string, cacheRoot: string): Sandbox {
  if (!dockerAvailable()) throw new Error('docker is required for offline inspection (start Docker Desktop / dockerd)');
  const image = parseImageDigest(fs.readFileSync(path.join(envDir, 'IMAGE_DIGEST'), 'utf8')).ref;
  const lock = fs.readFileSync(path.join(envDir, 'requirements.lock'), 'utf8');
  const venv = path.join(path.resolve(cacheRoot), `venv-${sha256Hex(`${image}|${lock}`).slice(2, 18)}`);
  if (!fs.existsSync(path.join(venv, '.ok'))) {
    fs.rmSync(venv, { recursive: true, force: true });
    fs.mkdirSync(venv, { recursive: true });
    fs.writeFileSync(path.join(venv, 'requirements.lock'), lock);
    const hashes = /--hash=sha256:/.test(lock) ? '--require-hashes' : '';
    const script = `set -e; python -m venv /venv; /venv/bin/pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: ${hashes} -r /venv/requirements.lock`;
    const r = spawnSync('docker', ['run', '--rm', '-v', `${venv}:/venv:rw`, image, 'sh', '-c', script], { encoding: 'utf8', timeout: 900_000 });
    if (r.status !== 0) throw new Error(`dependency install failed (pinned wheels only):\n${(r.stdout + r.stderr).slice(-3000)}`);
    spawnSync('chmod', ['-R', 'a+rX', venv]);
    fs.writeFileSync(path.join(venv, '.ok'), new Date().toISOString());
  }
  return {
    image,
    envDir: path.resolve(envDir),
    venv,
    description: `docker ${image} --network none --read-only --tmpfs /tmp --cpus 1 --memory 512m --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --user 65534`,
  };
}

/** Run `python <args>` (or a shell command with `shell: true`) offline inside the pinned image. */
export function runInSandbox(
  sb: Sandbox,
  args: string[],
  opts: { timeoutSec?: number; env?: Record<string, string>; shell?: boolean; networkNone?: boolean } = {},
): Promise<RunOut> {
  const env = { PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0', TZ: 'UTC', LC_ALL: 'C.UTF-8', HOME: '/tmp', TMPDIR: '/tmp', PATH: '/venv/bin:/usr/local/bin:/usr/bin:/bin', ...(opts.env ?? {}) };
  const name = `envm-buyer-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const argv = [
    'run', '--rm', '-i', '--name', name,
    '--network', opts.networkNone === false ? 'bridge' : 'none',
    '--read-only', '--tmpfs', '/tmp:rw,exec,size=256m',
    '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '65534:65534',
    '-v', `${sb.envDir}:/env:ro`, '-v', `${sb.venv}:/venv:ro`, '-w', '/env',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    sb.image,
    ...(opts.shell ? ['sh', '-c', args.join(' ')] : ['/venv/bin/python', ...args]),
  ];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout.length < 4_000_000 ? (stdout += d.toString()) : undefined));
    child.stderr.on('data', (d: Buffer) => (stderr.length < 1_000_000 ? (stderr += d.toString()) : undefined));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync('docker', ['kill', name], { stdio: 'ignore', timeout: 15_000 });
    }, (opts.timeoutSec ?? 300) * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - t0, argv: ['docker', ...argv] });
    });
  });
}
