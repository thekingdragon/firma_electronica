import { generateOtpCode, hashOtp, maskEmail, otpMatches } from './otp';

const SECRET = 's'.repeat(40);

describe('otp', () => {
  describe('generateOtpCode', () => {
    it('siempre son 6 dígitos, también con ceros a la izquierda', () => {
      for (let i = 0; i < 2000; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
    });

    it('no es constante', () => {
      expect(new Set(Array.from({ length: 50 }, generateOtpCode)).size).toBeGreaterThan(40);
    });
  });

  describe('hashOtp / otpMatches', () => {
    it('acepta el código correcto', () => {
      expect(otpMatches(SECRET, 'ch-1', '123456', hashOtp(SECRET, 'ch-1', '123456'))).toBe(true);
    });

    it('rechaza un código distinto', () => {
      expect(otpMatches(SECRET, 'ch-1', '123457', hashOtp(SECRET, 'ch-1', '123456'))).toBe(false);
    });

    it('el hash está ligado al desafío: el mismo código en otro desafío no coincide', () => {
      expect(otpMatches(SECRET, 'ch-2', '123456', hashOtp(SECRET, 'ch-1', '123456'))).toBe(false);
    });

    it('el hash depende del secreto del servidor', () => {
      expect(hashOtp(SECRET, 'ch-1', '123456')).not.toBe(hashOtp('x'.repeat(40), 'ch-1', '123456'));
    });

    it('el hash no contiene el código', () => {
      expect(hashOtp(SECRET, 'ch-1', '123456')).not.toContain('123456');
    });

    it('un hash guardado corrupto no rompe: simplemente no coincide', () => {
      expect(otpMatches(SECRET, 'ch-1', '123456', 'zz')).toBe(false);
      expect(otpMatches(SECRET, 'ch-1', '123456', '')).toBe(false);
    });
  });

  describe('maskEmail', () => {
    it('oculta el usuario y deja el dominio', () => {
      expect(maskEmail('ana@example.com')).toBe('a**@example.com');
      expect(maskEmail('juan.perez@empresa.pe')).toMatch(/^j\*+@empresa\.pe$/);
    });

    it('no revela cuántos caracteres tiene un usuario largo', () => {
      expect(maskEmail('a'.repeat(30) + '@x.co').length).toBeLessThan(15);
    });

    it('un texto sin @ no se devuelve', () => {
      expect(maskEmail('sin-arroba')).toBe('***');
    });
  });
});
