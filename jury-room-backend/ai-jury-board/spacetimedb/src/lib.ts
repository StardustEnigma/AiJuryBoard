export const SESSION_PHASE = {
  DISCOVERY_PENDING: 'DISCOVERY_PENDING',
  DISCOVERY_DONE: 'DISCOVERY_DONE',
  PROSECUTION_DONE: 'PROSECUTION_DONE',
  DEFENSE_DONE: 'DEFENSE_DONE',
  DEVILS_ADVOCATE_DONE: 'DEVILS_ADVOCATE_DONE',
  SYNTHESIS_PENDING: 'SYNTHESIS_PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type SessionPhase = (typeof SESSION_PHASE)[keyof typeof SESSION_PHASE];

export const JURY_ROLE = {
  PROSECUTION: 'PROSECUTION',
  DEFENSE: 'DEFENSE',
  DEVILS_ADVOCATE: 'DEVILS_ADVOCATE',
} as const;

export type JuryRole = (typeof JURY_ROLE)[keyof typeof JURY_ROLE];

export const MESSAGE_STATUS = {
  DRAFT: 'DRAFT',
  VALIDATED: 'VALIDATED',
  BROADCASTABLE: 'BROADCASTABLE',
  SPOKEN: 'SPOKEN',
} as const;

export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];

export const DEFAULT_MAX_ROUNDS = 3n;

export const OPENING_ROLE: JuryRole = JURY_ROLE.PROSECUTION;

export const MESSAGE_STATUS_ORDER: MessageStatus[] = [
  MESSAGE_STATUS.DRAFT,
  MESSAGE_STATUS.VALIDATED,
  MESSAGE_STATUS.BROADCASTABLE,
  MESSAGE_STATUS.SPOKEN,
];

export const EXPECTED_ROLE_BY_PHASE: Partial<Record<SessionPhase, JuryRole>> = {
  [SESSION_PHASE.DISCOVERY_DONE]: JURY_ROLE.PROSECUTION,
  [SESSION_PHASE.PROSECUTION_DONE]: JURY_ROLE.DEFENSE,
  [SESSION_PHASE.DEFENSE_DONE]: JURY_ROLE.DEVILS_ADVOCATE,
};

export const NEXT_PHASE_BY_ROLE: Record<JuryRole, SessionPhase> = {
  [JURY_ROLE.PROSECUTION]: SESSION_PHASE.PROSECUTION_DONE,
  [JURY_ROLE.DEFENSE]: SESSION_PHASE.DEFENSE_DONE,
  [JURY_ROLE.DEVILS_ADVOCATE]: SESSION_PHASE.DEVILS_ADVOCATE_DONE,
};

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function toCanonicalRole(value: string): JuryRole | undefined {
  const normalized = normalizeText(value)
    .toUpperCase()
    .replace(/['’]/g, '')
    .replace(/[\s-]+/g, '_');

  if (normalized === JURY_ROLE.PROSECUTION) {
    return JURY_ROLE.PROSECUTION;
  }
  if (normalized === JURY_ROLE.DEFENSE) {
    return JURY_ROLE.DEFENSE;
  }
  if (normalized === JURY_ROLE.DEVILS_ADVOCATE || normalized === 'DEVILS_ADVOCATE') {
    return JURY_ROLE.DEVILS_ADVOCATE;
  }

  return undefined;
}

export function isValidSessionPhase(value: string): value is SessionPhase {
  return Object.values(SESSION_PHASE).includes(value as SessionPhase);
}

export function isTerminalPhase(value: string): value is Exclude<SessionPhase, 'DISCOVERY_PENDING' | 'DISCOVERY_DONE' | 'PROSECUTION_DONE' | 'DEFENSE_DONE' | 'DEVILS_ADVOCATE_DONE' | 'SYNTHESIS_PENDING'> {
  return value === SESSION_PHASE.COMPLETED || value === SESSION_PHASE.FAILED;
}

export function isValidMessageStatus(value: string): value is MessageStatus {
  return Object.values(MESSAGE_STATUS).includes(value as MessageStatus);
}

export function canAdvanceMessageStatus(current: MessageStatus, next: MessageStatus): boolean {
  const currentIndex = MESSAGE_STATUS_ORDER.indexOf(current);
  const nextIndex = MESSAGE_STATUS_ORDER.indexOf(next);
  return nextIndex === currentIndex || nextIndex === currentIndex + 1;
}

export function roundForRole(role: JuryRole): bigint {
  if (role === JURY_ROLE.PROSECUTION) {
    return 1n;
  }
  if (role === JURY_ROLE.DEFENSE) {
    return 2n;
  }
  return 3n;
}