import { useRef, useState, type FormEvent } from 'react';
import { formatDateTime } from '../format';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, type CreateRequestBody } from '../api';
import { useSession } from '../auth';
import { LinkBox } from '../components/LinkBox';
import { newUuid } from '../format';
import { getDocumentTypeUi, listDocumentTypeUis, type Draft } from '../document-types';

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
  if (!EMAIL.test(f.email.trim())) out.email = 'Ingrese un correo válido: allí llegará el código de verificación.';
  return out;
}

export function NewRequest() {
  const types = listDocumentTypeUis();
  const [docType, setDocType] = useState(types[0].code);
  const ui = getDocumentTypeUi(docType) ?? types[0];
  const [form, setForm] = useState<Form>(EMPTY);
  // Los campos propios del tipo de documento (en la carta, los seguros) los define su cara en `document-types/`.
  const [draft, setDraft] = useState<Draft>(() => types[0].emptyDraft());
  const [draftErrors, setDraftErrors] = useState<Draft>({});
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
    const missingData = ui.validate(draft);
    setShown(missing);
    setDraftErrors(missingData);
    if (Object.keys(missing).length || Object.keys(missingData).length) {
      setServerError(null);
      return;
    }
    const body: CreateRequestBody = {
      documentType: ui.code,
      externalRef: form.externalRef.trim() || `panel-${idempotencyKey.current.slice(0, 8)}`,
      signer: { name: form.signerName.trim(), documentType: form.idType, documentNumber: form.idNumber.trim() },
      data: ui.toData(draft),
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
    setDraft(ui.emptyDraft());
    setDraftErrors({});
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
            {formatDateTime(result.expiresAt)}
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
              {result.signUrl && <LinkBox url={result.signUrl} signerName={signerName} phone={phone} documentName={ui.name} />}
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
        {types.length > 1 ? (
          <>
            <label htmlFor="docType">Tipo de documento *</label>
            <select
              id="docType"
              value={docType}
              onChange={(e) => {
                const next = getDocumentTypeUi(e.target.value) ?? types[0];
                setDocType(next.code);
                setDraft(next.emptyDraft());
                setDraftErrors({});
              }}
            >
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <h2>{ui.name}</h2>
        )}

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

        <ui.Fields
          draft={draft}
          errors={draftErrors}
          invalid={(k) => (draftErrors[k] ? 'invalid' : '')}
          onChange={(k, v) => {
            setDraft((d) => ({ ...d, [k]: v }));
            setDraftErrors((e) => ({ ...e, [k]: '' }));
          }}
        />

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

        {(Object.values(shown).some(Boolean) || Object.values(draftErrors).some(Boolean)) && <p className="error" role="alert">Revise los campos marcados.</p>}
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
