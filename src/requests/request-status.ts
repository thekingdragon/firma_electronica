/**
 * Estados de una solicitud de firma y las únicas transiciones permitidas.
 *
 * Solo PENDING puede cambiar; los demás son terminales. Un documento firmado no se edita: si
 * cambian los datos, se crea otra solicitud. Es la misma regla que protegen los CHECK de
 * `signature_requests`, pero acá se rechaza antes de llegar a la base.
 */
export const REQUEST_STATUSES = ['PENDING', 'SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ['SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED'],
  SIGNED: [],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: RequestStatus,
    public readonly to: RequestStatus,
  ) {
    super(`Una solicitud ${from} no puede pasar a ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: RequestStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
