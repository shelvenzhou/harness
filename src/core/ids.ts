import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Typed id brands. Prevents accidentally passing a ThreadId where a TurnId
 * is expected without paying for nominal types.
 */

export type ThreadId = string & { readonly __brand: 'ThreadId' };
export type TurnId = string & { readonly __brand: 'TurnId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };
export type HandleRef = string & { readonly __brand: 'HandleRef' };

export const newThreadId = (): ThreadId => `thr_${short()}` as ThreadId;
export const newTurnId = (): TurnId => `trn_${short()}` as TurnId;
export const newEventId = (): EventId => `evt_${short()}` as EventId;
export const newToolCallId = (): ToolCallId => `tc_${short()}` as ToolCallId;
export const newHandleRef = (): HandleRef => `h_${short()}` as HandleRef;

export const asThreadId = (s: string): ThreadId => s as ThreadId;
export const asTurnId = (s: string): TurnId => s as TurnId;

function short(): string {
  // 12 hex chars ≈ 48 bits; enough for session-scoped uniqueness.
  // randomUUID is 122 bits but verbose; we keep ids compact for logs.
  return randomBytes(6).toString('hex');
}

export { randomUUID };
