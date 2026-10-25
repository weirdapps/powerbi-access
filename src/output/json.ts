// src/output/json.ts
import { PowerBiHttpError } from '../http/errors';
import { ExitCode, ExitWithCode, type ExitCodeValue } from '../util/exit-codes';

export function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function emitError(payload: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(payload) + '\n');
}

export function toExit(err: unknown): { code: ExitCodeValue; payload: Record<string, unknown> } {
  if (err instanceof ExitWithCode) {
    return { code: err.code, payload: { ...err.payload } };
  }
  if (err instanceof PowerBiHttpError) {
    const e = err.toExit();
    return { code: e.code, payload: { ...e.payload } };
  }
  return {
    code: ExitCode.Internal,
    payload: { code: 'internal', message: (err as Error)?.message ?? String(err) },
  };
}
