// FECHAS Y ZONAS HORARIAS. Portado de gestor_segurov3 (packages/contracts/src/fechas.ts): lo guardado es siempre un instante
// (timestamptz / UTC); la zona de la corredora solo decide cómo se MUESTRA, y siempre con el desfase al lado, nunca en UTC
// a secas: «04/10/2026 12:35 (UTC-5)». Esta es la copia del NAVEGADOR; la del servidor vive en apps/api/src/common/fechas.ts: si se cambia una, cambiar la otra.

/** Zona por defecto de las corredoras ya creadas (Perú). Cada corredora puede tener la suya. */
export const ZONA_POR_DEFECTO = 'America/Lima';

/** Nombre IANA de zona ('America/Lima'). Nunca un desfase ('-05'): no sigue el horario de verano. */
export const ZONA_IANA_RE = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

/** ¿La zona existe de verdad en este motor? (la regla de arriba solo comprueba la forma). */
export const esZonaValida = (zona: string): boolean => {
  if (!ZONA_IANA_RE.test(zona)) return false;
  try {
    new Intl.DateTimeFormat('es-PE', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
};

/** Minutos de diferencia con UTC de una zona en un instante (Lima: -300). Es el de ESE instante. */
export const minutosDeDesfase = (zona: string, instante: Date = new Date()): number => {
  try {
    const nombre =
      new Intl.DateTimeFormat('en-US', { timeZone: zona, timeZoneName: 'shortOffset' }).formatToParts(instante).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = nombre.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return 0;
  }
};

/** El desfase para mostrar: 'UTC-5', 'UTC+5:30', 'UTC'. */
export const desfaseUtc = (zona?: string | null, instante: Date = new Date()): string => {
  if (!zona) return '';
  const min = minutosDeDesfase(zona, instante);
  if (min === 0) return 'UTC';
  const abs = Math.abs(min);
  const hm = abs % 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` : String(abs / 60);
  return `UTC${min < 0 ? '-' : '+'}${hm}`;
};

/** Un instante como fecha larga en una zona: '4 de octubre de 2026'. Es el día que fue EN ESA ZONA. */
export const fechaLargaEnZona = (instante: Date, zona: string): string =>
  instante.toLocaleDateString('es-PE', { timeZone: zona, day: 'numeric', month: 'long', year: 'numeric' });

/** Un instante con hora en una zona, con el desfase al lado: '04/10/2026 12:35 (UTC-5)'. `segundos` agrega los segundos. */
export const fechaHoraEnZona = (instante: Date, zona: string, opts: { segundos?: boolean } = {}): string => {
  const texto = new Intl.DateTimeFormat('es-PE', {
    timeZone: zona,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.segundos ? { second: '2-digit' } : {}),
    hour12: false,
  })
    .format(instante)
    .replace(',', '');
  return `${texto} (${desfaseUtc(zona, instante)})`;
};

/** Un instante con hora en una zona, con el desfase al lado: '04/10/2026 12:35 (UTC-5)'. Acepta el texto ISO del servidor. */
export const fechaHoraEnZonaIso = (iso: string, zona: string, opts: { segundos?: boolean } = {}): string => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : fechaHoraEnZona(d, zona, opts);
};

/** Zona del navegador de quien mira (para el panel de operador, que no pertenece a ninguna corredora). */
export const zonaDelNavegador = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Todas las zonas que conoce el navegador (para el selector de ajustes), con UTC al principio. */
export const zonasDisponibles = (): string[] => {
  try {
    const z = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return ['UTC', ...z.filter((x) => x !== 'UTC')];
  } catch {
    return ['UTC', ZONA_POR_DEFECTO];
  }
};
