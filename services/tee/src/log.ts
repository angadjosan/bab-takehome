/** Structured JSON-lines logging to stdout (public-safe: never log secrets, task text or keys). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? 20;

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
