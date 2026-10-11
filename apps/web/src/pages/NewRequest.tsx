import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, type CreateRequestBody } from '../api';
import { useSession } from '../auth';
import { LinkBox } from '../components/LinkBox';
import { newUuid } from '../format';

type Created = Awaited<ReturnType<typeof api.create>>;

const ID_TYPES = ['DNI', 'CE', 'Pasaporte', 'RUC'];
const EXPIRY_OPTIONS = [
  { hours: 24, label: '24 horas' },
  { hours: 48, label: '48 horas' },
  { hours: 72, label: '72 horas' },
  { hours: 168, label: '7 días' },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Form {
  signerName: string;
  idType: string;
  idNumber: string;
  insurances: string;
  email: string;
  phone: string;
  externalRef: string;
  expiresInHours: number;
  /** El servicio envía el enlace por correo; si no, lo envía quien usa el panel (copiar o WhatsApp). */
  sendByService: boolean;
}

const EMPTY: Form = {
  signerName: '',
  idType: 'DNI',
  idNumber: '',
  insurances: '',
  email: '',
  phone: '',
  externalRef: '',
  expiresInHours: 48,
  sendByService: false,
};

/** Qué falta, por campo. El botón siempre se puede pulsar: al pulsar se marca lo que falta. */
function faltas(f: Form): Partial<Record<keyof Form, string>> {
  const out: Partial<Record<keyof Form, string>> = {};
  if (f.signerName.trim().length < 2) out.signerName = 'Ingrese el nombre completo del firmante.';
  if (!f.idNumber.trim()) out.idNumber = 'Ingrese el número de documento.';
  if (!f.insurances.split('\n').some((l) => l.trim())) out.insurances = 'Ingrese al menos un seguro.';
  if (!EMAIL.test(f.email.trim())) out.email = 'Ingrese un correo válido: allí llegará el código de verificación.';
  return out;
}

export function NewRequest() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [shown, setShown] = useState<Partial<Record<keyof Form, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ result: Created; signerName: string; phone: string } | null>(null);
  // Una clave por formulario abierto: un doble clic no crea dos solicitudes.
  const idempotencyKey = useRef(newUuid());

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setShown((s) => ({ ...s, [k]: undefined }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const missing = faltas(form);
    setShown(missing);
    if (Object.keys(missing).length) {
      setServerError(null);
      return;
    }
    const body: CreateRequestBody = {
      documentType: 'APPOINTMENT_LETTER',
      externalRef: form.externalRef.trim() || `panel-${idempotencyKey.current.slice(0, 8)}`,
      signer: { name: form.signerName.trim(), documentType: form.idType, documentNumber: form.idNumber.trim() },
      data: { insurances: form.insurances.split('\n').map((l) => l.trim()).filter(Boolean) },
      otp: { channel: 'EMAIL', to: form.email.trim() },
      delivery: form.sendByService ? { mode: 'SERVICE', channel: 'EMAIL', to: form.email.trim() } : { mode: 'HOST' },
      expiresInHours: form.expiresInHours,
    };
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.create(body, idempotencyKey.current);
      setCreated({ result, signerName: body.signer.name, phone: form.phone });
    } catch (err) {
      if (err instanceof ApiRequestError && err.issues.length) {
        setServerError(`${err.message} ${err.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
      } else {
        setServerError(err instanceof Error ? err.message : 'No se pudo crear la solicitud.');
      }
    } finally {
      setBusy(false);
    }
  }

  function another() {
    idempotencyKey.current = newUuid();
    setForm(EMPTY);
    setShown({});
    setServerError(null);
    setCreated(null);
  }

  if (created) {
    const { result, signerName, phone } = created;
    return (
      <>
        <h1>Solicitud creada</h1>
        <div className="card">
          <p>
            Referencia <strong>{result.reference}</strong> · vence el{' '}
            {new Date(result.expiresAt).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
          {result.sentTo ? (
            <>
              <h2>Enlace enviado</h2>
              <p>Enviamos el enlace por correo a <strong>{result.sentTo}</strong>.</p>
              {result.warnings?.includes('LINK_AND_OTP_SAME_CHANNEL') && (
                <p className="notice" role="note">
                  <strong>Atención:</strong> el enlace y el código de verificación llegan al <strong>mismo correo</strong>. Quien
                  abra ese buzón tendrá las dos cosas: la verificación protege menos. Para más seguridad, envíe el enlace
                  por otro medio (WhatsApp) y deje el código por correo.
                </p>
              )}
            </>
          ) : (
            <>
              <h2>Envíe el enlace al firmante</h2>
              {result.signUrl && <LinkBox url={result.signUrl} signerName={signerName} phone={phone} />}
              <p className="hint">
                El código de verificación (OTP) lo recibirá el firmante por correo al abrir el enlace. Por seguridad no
                se envía por el mismo medio que el enlace.
              </p>
            </>
          )}
          <div className="actions">
            <Link className="btn" to={`/solicitudes/${result.id}`}>
              Ver detalle
            </Link>
            <button type="button" className="btn btn-primary" onClick={another}>
              Crear otra
            </button>
          </div>
        </div>
      </>
    );
  }

  const field = (k: keyof Form) => (shown[k] ? 'invalid' : '');

  return (
    <>
      <h1>Nueva solicitud</h1>
      <form className="card form" onSubmit={submit} noValidate>
        <h2>Carta de nombramiento</h2>

        <div className="grid">
          <div className="span-2">
            <label htmlFor="signerName">Nombre completo del firmante *</label>
            <input id="signerName" value={form.signerName} className={field('signerName')} onChange={(e) => set('signerName', e.target.value)} />
            {shown.signerName && <p className="error">{shown.signerName}</p>}
          </div>
          <div>
            <label htmlFor="idType">Tipo de documento</label>
            <select id="idType" value={form.idType} onChange={(e) => set('idType', e.target.value)}>
              {ID_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="idNumber">Número de documento *</label>
            <input id="idNumber" inputMode="numeric" value={form.idNumber} className={field('idNumber')} onChange={(e) => set('idNumber', e.target.value)} />
            {shown.idNumber && <p className="error">{shown.idNumber}</p>}
          </div>
        </div>

        <label htmlFor="insurances">Seguros que se nombran *</label>
        <textarea
          id="insurances"
          rows={4}
          value={form.insurances}
          className={field('insurances')}
          onChange={(e) => set('insurances', e.target.value)}
          placeholder={'Un seguro por línea, por ejemplo:\nSCTR Salud\nSCTR Pensión'}
        />
        <p className="hint">Son las líneas A, B, C… de la carta: el tipo de seguro, no el número de póliza.</p>
        {shown.insurances && <p className="error">{shown.insurances}</p>}

        <div className="grid">
          <div>
            <label htmlFor="email">Correo del firmante *</label>
            <input id="email" type="email" value={form.email} className={field('email')} onChange={(e) => set('email', e.target.value)} />
            <p className="hint">Aquí llega el código de verificación.</p>
            {shown.email && <p className="error">{shown.email}</p>}
          </div>
          <div>
            <label htmlFor="phone">WhatsApp del firmante</label>
            <input id="phone" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+51 999 999 999" />
            <p className="hint">Solo arma el botón de WhatsApp; no se guarda.</p>
          </div>
          <div className="span-2">
            <label className="check">
              <input type="checkbox" checked={form.sendByService} onChange={(e) => set('sendByService', e.target.checked)} />
              <span>
                <strong>Enviar el enlace por correo desde el servicio</strong>
                <span className="hint block">
                  Si no, usted copia el enlace o lo envía por WhatsApp. Requiere que la corredora tenga configurado su
                  correo. Ojo: el código de verificación también llega por correo.
                </span>
              </span>
            </label>
          </div>
          <div>
            <label htmlFor="externalRef">Referencia interna</label>
            <input id="externalRef" value={form.externalRef} onChange={(e) => set('externalRef', e.target.value)} placeholder="Su código del cliente" />
          </div>
          <div>
            <label htmlFor="expires">El enlace vence en</label>
            <select id="expires" value={form.expiresInHours} onChange={(e) => set('expiresInHours', Number(e.target.value))}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {Object.values(shown).some(Boolean) && <p className="error" role="alert">Revise los campos marcados.</p>}
        {serverError && <p className="error" role="alert">{serverError}</p>}

        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creando…' : 'Crear solicitud'}
          </button>
          <Link className="btn btn-ghost" to="/solicitudes">
            Cancelar
          </Link>
        </div>
      </form>
    </>
  );
}
