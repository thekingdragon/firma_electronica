import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, mailApi, type MailSettings } from '../api';
import { useSession } from '../auth';
import { formatDateTime } from '../format';

/** Servidores de los proveedores más comunes: solo rellenan servidor, puerto y seguridad; todo se puede cambiar. */
const PRESETS: { name: string; host: string; port: number; secure: boolean | null; hint: string }[] = [
  {
    name: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    hint: 'Google no acepta su contraseña normal: active la verificación en dos pasos y cree una «contraseña de aplicación» en su cuenta de Google; esa es la que va aquí.',
  },
  {
    name: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    hint: 'En Microsoft 365 el administrador del correo debe tener habilitado «SMTP autenticado» para esa cuenta, y a veces hace falta una contraseña de aplicación. Si falla con «SendAsDenied», el remitente debe ser la propia cuenta.',
  },
];

interface Form {
  host: string;
  port: string;
  secure: 'auto' | 'tls' | 'starttls';
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
}

const secureOf = (s: boolean | null): Form['secure'] => (s === null ? 'auto' : s ? 'tls' : 'starttls');
const fromView = (v: MailSettings | null, fallbackEmail: string): Form => ({
  host: v?.host ?? '',
  port: v?.port ? String(v.port) : '587',
  secure: secureOf(v ? v.secure : false),
  username: v?.username ?? fallbackEmail,
  password: '',
  fromName: v?.fromName ?? '',
  fromEmail: v?.fromEmail ?? fallbackEmail,
  replyTo: v?.replyTo ?? '',
});
const message = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

/**
 * El correo de la corredora: con este servidor se envían el código de verificación, el enlace de firma y la copia del documento
 * firmado. La contraseña se guarda cifrada y no se vuelve a mostrar; «Enviar prueba» comprueba que todo funciona de verdad.
 */
export function MailSettingsCard() {
  const { user } = useSession();
  const [view, setView] = useState<MailSettings | null>(null);
  const [form, setForm] = useState<Form>(() => fromView(null, user.email));
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState(user.email);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    mailApi
      .get()
      .then((v) => {
        setView(v);
        setForm(fromView(v.configured ? v : null, user.email));
      })
      .catch((e) => setError(message(e, 'No se pudo cargar el correo.')));
  }, [user.email]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
    setTestResult(null);
  };

  function preset(i: number) {
    const p = PRESETS[i];
    if (!p) return setHint(null);
    setForm((f) => ({ ...f, host: p.host, port: String(p.port), secure: secureOf(p.secure) }));
    setHint(p.hint);
    setSaved(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const port = Number(form.port);
    if (!form.host.trim() || !Number.isInteger(port) || !form.fromEmail.trim()) return setError('Complete el servidor, el puerto y el correo remitente.');
    if (form.username.trim() && !form.password && !view?.hasPassword) return setError('Con usuario hay que indicar la contraseña.');
    setBusy(true);
    try {
      const v = await mailApi.save({
        host: form.host.trim(),
        port,
        secure: form.secure === 'auto' ? null : form.secure === 'tls',
        username: form.username.trim() || null,
        ...(form.password ? { password: form.password } : {}),
        fromName: form.fromName.trim() || null,
        fromEmail: form.fromEmail.trim(),
        replyTo: form.replyTo.trim() || null,
      });
      setView(v);
      setForm((f) => ({ ...f, password: '' }));
      setSaved(true);
    } catch (err) {
      const issues = err instanceof ApiRequestError && err.issues.length ? ` ${err.issues.map((i) => i.message).join(' ')}` : '';
      setError(`${message(err, 'No se pudo guardar.')}${issues}`);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      await mailApi.test(testTo.trim());
      setView(await mailApi.get());
      setTestResult({ ok: true, text: `Listo: se envió un correo de prueba a ${testTo.trim()}. Revise la bandeja (y el spam).` });
    } catch (err) {
      setView(await mailApi.get().catch(() => view));
      setTestResult({ ok: false, text: message(err, 'No se pudo enviar la prueba.') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card">
      <h2>Correo de la corredora</h2>
      <p className="muted">
        Con este correo se envían el <strong>código de verificación</strong> que recibe el firmante, el enlace de firma y la copia del documento firmado.
        Sin él, el firmante no puede recibir el código.
      </p>

      {view && (
        <p>
          {!view.configured ? (
            <span className="badge badge-expired">Sin configurar</span>
          ) : view.verifiedAt ? (
            <span className="badge badge-signed">Verificado el {formatDateTime(view.verifiedAt)}</span>
          ) : (
            <span className="badge badge-unreviewed">Guardado, sin probar</span>
          )}
          {view.lastError && <span className="warn"> Último error de envío: {view.lastError}</span>}
        </p>
      )}

      <form onSubmit={save} noValidate>
        <label htmlFor="mail-preset">Proveedor</label>
        <select id="mail-preset" defaultValue="" onChange={(e) => preset(e.target.value === '' ? -1 : Number(e.target.value))}>
          <option value="">Otro (escribo los datos)</option>
          {PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        {hint && (
          <p className="notice" role="note">
            {hint}
          </p>
        )}

        <div className="grid">
          <div>
            <label htmlFor="mail-host">Servidor *</label>
            <input id="mail-host" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label htmlFor="mail-port">Puerto *</label>
            <input id="mail-port" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} />
          </div>
          <div>
            <label htmlFor="mail-secure">Seguridad</label>
            <select id="mail-secure" value={form.secure} onChange={(e) => set('secure', e.target.value as Form['secure'])}>
              <option value="starttls">STARTTLS (puerto 587)</option>
              <option value="tls">TLS directo (puerto 465)</option>
              <option value="auto">Automática según el puerto</option>
            </select>
          </div>
          <div>
            <label htmlFor="mail-user">Usuario</label>
            <input id="mail-user" autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="su correo completo" />
          </div>
          <div className="span-2">
            <label htmlFor="mail-pass">Contraseña{form.username.trim() && !view?.hasPassword ? ' *' : ''}</label>
            <input
              id="mail-pass"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder={view?.hasPassword ? 'Ya hay una guardada: déjelo en blanco para conservarla' : ''}
            />
            <p className="hint">Se guarda cifrada y no se vuelve a mostrar.</p>
          </div>
          <div>
            <label htmlFor="mail-from">Correo desde el que se envía *</label>
            <input id="mail-from" type="email" value={form.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} />
          </div>
          <div>
            <label htmlFor="mail-name">Nombre que ve el firmante</label>
            <input id="mail-name" value={form.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder="Mi Corredora de Seguros" />
          </div>
          <div className="span-2">
            <label htmlFor="mail-reply">Responder a</label>
            <input id="mail-reply" type="email" value={form.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
          </div>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="ok" role="status">
            Guardado. Ahora envíe una prueba para comprobar que funciona.
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar el correo'}
          </button>
        </div>
      </form>

      {view?.configured && (
        <div className="mail-test">
          <h3>Enviar una prueba</h3>
          <label htmlFor="mail-test-to">Enviar a</label>
          <input id="mail-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => void test()} disabled={testing || !testTo.trim()}>
              {testing ? 'Enviando…' : 'Enviar correo de prueba'}
            </button>
          </div>
          {testResult && (
            <p className={testResult.ok ? 'ok' : 'error'} role={testResult.ok ? 'status' : 'alert'}>
              {testResult.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
