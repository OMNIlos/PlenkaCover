import { AsyncLocalStorage } from 'node:async_hooks';

type Fields = Record<string, unknown>;

const logSuppression = new AsyncLocalStorage<boolean>();

export function withSuppressedLogs<T>(operation: () => T): T {
  return logSuppression.run(true, operation);
}

/**
 * Structured JSON-line logger. One line per event so Windows service wrappers / `findstr`
 * / log shippers can consume it without a parsing layer.
 */
function write(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields): void {
  if (logSuppression.getStore() === true) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
