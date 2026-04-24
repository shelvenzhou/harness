import { randomBytes } from 'node:crypto';

/**
 * Minimal W3C traceparent helpers.
 * Format: `00-<trace-id:32hex>-<parent-id:16hex>-<flags:2hex>`
 */

export interface TraceContext {
  traceId: string;
  parentId: string;
  flags: string;
}

export function newRootTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

export function childOf(parentTraceparent: string | undefined): string {
  const parsed = parentTraceparent ? tryParse(parentTraceparent) : undefined;
  const traceId = parsed?.traceId ?? randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  const flags = parsed?.flags ?? '01';
  return `00-${traceId}-${parentId}-${flags}`;
}

export function tryParse(tp: string): TraceContext | undefined {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(tp);
  if (!m) return undefined;
  return { traceId: m[2]!, parentId: m[3]!, flags: m[4]! };
}
