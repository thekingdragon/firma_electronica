import { base32Encode, base32Decode, hotp, verifyTotp, stepFor, otpauthUri, STEP_SECONDS } from './totp';

/**
 * La implementación de TOTP es propia (ver el porqué en `totp.ts`), así que hay
 * que demostrar que es correcta y no solo que «funciona con mi teléfono». Estos
 * vectores están publicados en los propios RFC: si el código de abajo los pasa,
 * genera exactamente lo mismo que Google Authenticator.
 */
describe('base32 (RFC 4648, sección 10)', () => {
  const vectores: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  // Sin relleno: los URI otpauth:// no lo llevan, así que se compara contra el
  // vector del RFC con los '=' quitados.
  it.each(vectores)('codifica «%s»', (texto, esperado) => {
    expect(base32Encode(Buffer.from(texto))).toBe(esperado);
  });
  it.each(vectores)('decodifica de vuelta «%s»', (texto, codificado) => {
    expect(base32Decode(codificado).toString()).toBe(texto);
  });

  it('tolera minúsculas, espacios, guiones y relleno', () => {
    // Es como llega cuando alguien lo teclea a mano desde la pantalla de registro.
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
  });

  it('rechaza caracteres que no son base32', () => {
    // El 0, el 1 y el 8 NO están en el alfabeto: es justo la confusión que se
    // produce al teclear a mano, y tiene que fallar en vez de decodificar basura.
    expect(() => base32Decode('MZXW0')).toThrow();
  });
});

describe('HOTP (RFC 4226, apéndice D)', () => {
  const secreto = Buffer.from('12345678901234567890');
  const esperados = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  it.each(esperados.map((c, i) => [i, c]))('contador %i → %s', (contador, codigo) => {
    expect(hotp(secreto, contador as number)).toBe(codigo);
  });
});

describe('TOTP (RFC 6238, apéndice B)', () => {
  // El RFC publica sus vectores con OCHO dígitos; nosotros emitimos seis, así que
  // se comparan los seis últimos, que es la misma operación con otro módulo.
  const secreto = Buffer.from('12345678901234567890');
  const vectores: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  it.each(vectores)('t=%i → %s', (segundos, ochoDigitos) => {
    const paso = Math.floor((segundos as number) / STEP_SECONDS);
    expect(hotp(secreto, paso, 8)).toBe(ochoDigitos);
    expect(hotp(secreto, paso, 6)).toBe((ochoDigitos as string).slice(-6));
  });
});

describe('verifyTotp', () => {
  // '12345678901234567890' en base32.
  const secretoB32 = base32Encode(Buffer.from('12345678901234567890'));
  const ahora = 1_700_000_000_000; // instante fijo: la prueba no puede depender del reloj
  const pasoActual = stepFor(ahora);
  const codigoDe = (paso: number) => hotp(Buffer.from('12345678901234567890'), paso);

  it('acepta el código de la ventana actual y devuelve su paso', () => {
    expect(verifyTotp(secretoB32, codigoDe(pasoActual), { atMs: ahora })).toBe(pasoActual);
  });

  it('acepta el anterior y el siguiente (desfase de reloj de ±30 s)', () => {
    expect(verifyTotp(secretoB32, codigoDe(pasoActual - 1), { atMs: ahora })).toBe(pasoActual - 1);
    expect(verifyTotp(secretoB32, codigoDe(pasoActual + 1), { atMs: ahora })).toBe(pasoActual + 1);
  });

  it('rechaza dos ventanas más allá', () => {
    expect(verifyTotp(secretoB32, codigoDe(pasoActual + 2), { atMs: ahora })).toBeNull();
    expect(verifyTotp(secretoB32, codigoDe(pasoActual - 2), { atMs: ahora })).toBeNull();
  });

  it('rechaza un código ya consumido aunque su ventana siga abierta', () => {
    // Es la protección contra reenvío: sin minStep, un código visto por encima del
    // hombro sirve para entrar otra vez durante los 30 s siguientes.
    const codigo = codigoDe(pasoActual);
    expect(verifyTotp(secretoB32, codigo, { atMs: ahora, minStep: pasoActual })).toBeNull();
    // …y tampoco vale el de la ventana anterior una vez consumida la actual.
    expect(verifyTotp(secretoB32, codigoDe(pasoActual - 1), { atMs: ahora, minStep: pasoActual })).toBeNull();
    // El siguiente sí, que todavía no se ha usado.
    expect(verifyTotp(secretoB32, codigoDe(pasoActual + 1), { atMs: ahora, minStep: pasoActual })).toBe(pasoActual + 1);
  });

  it('rechaza lo que no sean seis dígitos sin tocar el HMAC', () => {
    for (const basura of ['', '12345', '1234567', 'abcdef', '12 34 56', '<script>']) {
      expect(verifyTotp(secretoB32, basura, { atMs: ahora })).toBeNull();
    }
  });
});

describe('otpauthUri', () => {
  it('lleva el emisor en la etiqueta y como parámetro', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'ana@ejemplo.com');
    // Redundante a propósito: hay aplicaciones que solo leen uno de los dos.
    expect(uri).toContain('otpauth://totp/Firma%20electr%C3%B3nica%3Aana%40ejemplo.com');
    expect(uri).toContain('issuer=Firma+electr%C3%B3nica');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
