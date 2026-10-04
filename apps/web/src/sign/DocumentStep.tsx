import { useState } from 'react';
import type { PowerDef, SigningView } from './signApi';

export interface SignForm {
  powers: string[];
  observation: string;
  accepted: boolean;
}

/** Valores iniciales: las facultades marcadas por defecto en la plantilla. */
export function initialForm(view: SigningView): SignForm {
  return {
    powers: (view.content.powers ?? []).filter((p) => p.defaultChecked).map((p) => p.code),
    observation: '',
    accepted: false,
  };
}

/** Qué falta, por campo. El botón siempre se puede pulsar: al pulsar se marca lo que falta. */
function missing(f: SignForm): { powers?: string; accepted?: string } {
  const out: { powers?: string; accepted?: string } = {};
  if (f.powers.length === 0 && f.observation.trim() === '') {
    out.powers = 'Marque al menos una facultad o escriba una observación.';
  }
  if (!f.accepted) out.accepted = 'Debe aceptar para poder firmar.';
  return out;
}

export function DocumentStep({
  view,
  form,
  onChange,
  onContinue,
  continueLabel,
}: {
  view: SigningView;
  form: SignForm;
  onChange: (f: SignForm) => void;
  onContinue: () => void;
  continueLabel: string;
}) {
  const [shown, setShown] = useState<{ powers?: string; accepted?: string }>({});
  const t = view.content.texts ?? {};
  const powers: PowerDef[] = view.content.powers ?? [];
  const maxLen = view.content.observation?.maxLength ?? 1000;

  function toggle(code: string) {
    const next = form.powers.includes(code) ? form.powers.filter((c) => c !== code) : [...form.powers, code];
    onChange({ ...form, powers: next });
    setShown((s) => ({ ...s, powers: undefined }));
  }

  function next() {
    const m = missing(form);
    setShown(m);
    if (Object.keys(m).length === 0) onContinue();
  }

  return (
    <section className="card letter">
      <h2 className="letter-title">{t.title ?? 'Documento'}</h2>
      <p className="muted small">
        {view.issuer.legalName}
        {view.issuer.registryCode ? ` · Código de registro ${view.issuer.registryCode}` : ''} · Ref. {view.reference}
      </p>

      <p>
        {t.salutation}<br />
        <strong>{t.addressee}</strong><br />
        <strong>{view.issuer.legalName}</strong><br />
        {t.presente}
      </p>
      <p>{t.greeting}</p>
      <p>{t.body}</p>

      <ol className="insurances" type="A">
        {(view.data.insurances ?? []).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <p>{t.powersIntro}</p>
      <fieldset className={`powers${shown.powers ? ' invalid' : ''}`}>
        <legend className="sr-only">Facultades</legend>
        {powers.map((p) => (
          <label key={p.code} className="check">
            <input type="checkbox" checked={form.powers.includes(p.code)} onChange={() => toggle(p.code)} />
            <span>{p.text}</span>
          </label>
        ))}
      </fieldset>
      {shown.powers && <p className="error" role="alert">{shown.powers}</p>}

      <label htmlFor="obs">{t.observationLabel}</label>
      <textarea
        id="obs"
        rows={3}
        maxLength={maxLen}
        value={form.observation}
        onChange={(e) => {
          onChange({ ...form, observation: e.target.value });
          setShown((s) => ({ ...s, powers: undefined }));
        }}
      />
      <p className="hint">{form.observation.length}/{maxLen}</p>

      <div className="signer-box">
        <strong>{t.signerBlock}</strong>
        <div>Nombre: {view.signer.name}</div>
        <div>Documento: {view.signer.documentType} {view.signer.documentNumber}</div>
      </div>

      {view.annexText && (
        <details className="annex">
          <summary>Anexo: obligaciones del corredor de seguros (léalo antes de firmar)</summary>
          <div className="annex-text">{view.annexText}</div>
        </details>
      )}

      <div className={`accept${shown.accepted ? ' invalid' : ''}`}>
        <label className="check">
          <input
            type="checkbox"
            checked={form.accepted}
            onChange={(e) => {
              onChange({ ...form, accepted: e.target.checked });
              setShown((s) => ({ ...s, accepted: undefined }));
            }}
          />
          <span>{view.clause.text}</span>
        </label>
      </div>
      {shown.accepted && <p className="error" role="alert">{shown.accepted}</p>}
      {Object.values(shown).some(Boolean) && <p className="error" role="alert">Revise lo marcado en rojo.</p>}

      <button type="button" className="btn btn-primary btn-block" onClick={next}>
        {continueLabel}
      </button>
    </section>
  );
}
