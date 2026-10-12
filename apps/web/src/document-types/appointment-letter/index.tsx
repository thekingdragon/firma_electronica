import type { DocumentTypeUi } from '../types';

/**
 * CARTA DE NOMBRAMIENTO: lo propio de este tipo de documento en el panel (los seguros que se nombran). El núcleo del panel no
 * lo importa directamente: lo encuentra por el registro en `document-types/index.ts`.
 */
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const insurancesOf = (data: Record<string, unknown>): string[] => (Array.isArray(data.insurances) ? (data.insurances as string[]) : []);

export const appointmentLetterUi: DocumentTypeUi = {
  code: 'APPOINTMENT_LETTER',
  name: 'Carta de nombramiento',
  defaultListKey: 'insurances',
  emptyDraft: () => ({ insurances: '' }),
  validate: (d) => (lines(d.insurances ?? '').length ? {} : { insurances: 'Ingrese al menos un seguro.' }) as Record<string, string>,
  toData: (d) => ({ insurances: lines(d.insurances ?? '') }),
  Fields: ({ draft, errors, invalid, onChange }) => (
    <>
      <label htmlFor="insurances">Seguros que se nombran *</label>
      <textarea
        id="insurances"
        rows={4}
        value={draft.insurances ?? ''}
        className={invalid('insurances')}
        onChange={(e) => onChange('insurances', e.target.value)}
        placeholder={'Un seguro por línea, por ejemplo:\nSCTR Salud\nSCTR Pensión'}
      />
      <p className="hint">Son las líneas A, B, C… de la carta: el tipo de seguro, no el número de póliza.</p>
      {errors.insurances && <p className="error">{errors.insurances}</p>}
    </>
  ),
  summaryLabel: 'Seguros',
  summary: (data) => insurancesOf(data).length || '—',
  detail: (data) =>
    insurancesOf(data).length > 0 && (
      <>
        <dt>Seguros nombrados</dt>
        <dd>
          <ul>
            {insurancesOf(data).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </dd>
      </>
    ),
  reviewSummary: (data) => (
    <p>
      <strong>Seguros:</strong> {insurancesOf(data).join(' · ')}
    </p>
  ),
};
