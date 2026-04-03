export type JuryRole = 'prosecution' | 'defense';

export type SessionStatus = 'idle' | 'debating' | 'analyzing' | 'closed';

export const DEFAULT_MAX_ROUNDS = 6n;

export const OPENING_ROLE: JuryRole = 'prosecution';

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function nextRole(currentRole: JuryRole): JuryRole {
  return currentRole === 'prosecution' ? 'defense' : 'prosecution';
}

export function isValidRole(value: string): value is JuryRole {
  return value === 'prosecution' || value === 'defense';
}

export function isTerminalStatus(value: string): value is Exclude<SessionStatus, 'idle' | 'debating'> {
  return value === 'analyzing' || value === 'closed';
}