/**
 * Heimdall proxy. Phase 1 is a pass-through stub. Phase 2 adds real policy
 * enforcement (path allowlists, secret scanning, audit events to hub).
 */

export interface HeimdallOperation {
  type: 'read' | 'write' | 'execute';
  path?: string;
  content?: string;
}

export interface HeimdallDecision {
  allow: boolean;
  reason?: string;
}

export function checkOperation(_op: HeimdallOperation): HeimdallDecision {
  return { allow: true };
}
