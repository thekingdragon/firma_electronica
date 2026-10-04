import {
  REQUEST_STATUSES,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
} from './request-status';

describe('request-status', () => {
  it('PENDING puede pasar a cada estado final', () => {
    for (const to of ['SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED'] as const) {
      expect(canTransition('PENDING', to)).toBe(true);
    }
  });

  it('PENDING no puede pasar a PENDING', () => {
    expect(canTransition('PENDING', 'PENDING')).toBe(false);
  });

  it.each(['SIGNED', 'REJECTED', 'EXPIRED', 'REVOKED'] as const)(
    '%s es terminal: no puede pasar a ningún estado',
    (from) => {
      expect(isTerminal(from)).toBe(true);
      for (const to of REQUEST_STATUSES) expect(canTransition(from, to)).toBe(false);
    },
  );

  it('una solicitud firmada no se puede revocar ni expirar', () => {
    expect(() => assertTransition('SIGNED', 'REVOKED')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('SIGNED', 'EXPIRED')).toThrow(InvalidTransitionError);
  });

  it('el error dice de qué estado a cuál se intentó pasar', () => {
    expect(() => assertTransition('EXPIRED', 'SIGNED')).toThrow(
      'Una solicitud EXPIRED no puede pasar a SIGNED.',
    );
  });

  it('PENDING no es terminal', () => {
    expect(isTerminal('PENDING')).toBe(false);
  });
});
