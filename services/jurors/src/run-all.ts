/**
 * Start the three juror agents as child processes with prefixed, colored logs.
 *
 *   tsx src/run-all.ts                 # jurors 1,2,3
 *   JURORS=1,3 tsx src/run-all.ts      # subset
 *
 * A crashed child is restarted with backoff (its persisted state makes restarts safe: no
 * double-commit, reveals come from the persisted salt). SIGINT/SIGTERM are forwarded and the
 * supervisor waits for children to finish their in-flight work.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JUROR_TS = path.join(HERE, 'juror.ts');
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m'];
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const indices = (process.env.JURORS ?? '1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const children = new Map<number, ChildProcess>();
const restarts = new Map<number, number>();
let shuttingDown = false;

function pipe(n: number, stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) {
  const rl = createInterface({ input: stream });
  const c = useColor ? COLORS[(n - 1) % COLORS.length] : '';
  rl.on('line', (line) => {
    const tagged = line.startsWith(`[juror${n}`) ? line : `[juror${n}] ${line}`;
    out.write(useColor ? `${c}${tagged}${RESET}\n` : `${tagged}\n`);
  });
}

function start(n: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', JUROR_TS, 'run'], {
    env: { ...process.env, JUROR_INDEX: String(n) },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(HERE, '..'),
  });
  children.set(n, child);
  pipe(n, child.stdout!, process.stdout);
  pipe(n, child.stderr!, process.stderr);
  child.on('exit', (code, signal) => {
    children.delete(n);
    if (shuttingDown) {
      console.log(`[run-all] juror${n} exited (${signal ?? code})`);
      if (children.size === 0) process.exit(0);
      return;
    }
    const k = (restarts.get(n) ?? 0) + 1;
    restarts.set(n, k);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(k, 5));
    console.error(`[run-all] juror${n} exited (${signal ?? code}); restart #${k} in ${delay / 1000}s`);
    setTimeout(() => !shuttingDown && start(n), delay);
  });
}

function shutdown(sig: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[run-all] ${sig}: stopping ${children.size} juror(s)`);
  for (const c of children.values()) c.kill('SIGTERM');
  if (children.size === 0) process.exit(0);
  setTimeout(() => {
    for (const c of children.values()) c.kill('SIGKILL');
    process.exit(1);
  }, 60_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`[run-all] starting jurors ${indices.join(', ')}`);
for (const n of indices) start(n);
