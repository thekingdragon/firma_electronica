import { useState } from 'react';
import { Rich } from '../components/Rich';
import { powersOf, type SigningView, type ViewBlock } from './signApi';

export interface SignForm {
  powers: string[];
  observation: string;
  /** Códigos de los consentimientos marcados. */
  consents: string[];
  accepted: boolean;
}

/** Valores iniciales: las facultades marcadas por defecto en la plantilla. */
export function initialForm(view: SigningView): SignForm {
  return {
    powers: (powersOf(view)?.items ?? []).filter((p) => p.defaultChecked).map((p) => p.code),
    observation: '',
    // Los consentimientos NO vienen marcados: el firmante los marca él, uno por uno.
    consents: [],
    accepted: false,
  };
}

/** Qué falta, por campo. El botón siempre se puede pulsar: al pulsar se marca lo que falta. */
function missing(view: SigningView, f: SignForm): { powers?: string; consents?: string; accepted?: string } {
  const out: { powers?: string; consents?: string; accepted?: string } = {};
  const pending = view.blocks.filter((b) => b.type === 'consent' && b.required && !f.consents.includes(b.code));
  if (pending.length > 0) out.consents = 'Debe aceptar este consentimiento para poder firmar.';
  const block = powersOf(view);
  const asks = block !== null && (block.items.length > 0 || block.observation.enabled);
  if (block && asks && f.powers.length === 0 && f.observation.trim() === '') {
    out.powers = block.observation.enabled ? 'Marque al menos una facultad o escriba una observación.' : 'Marque al menos una facultad.';
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
  const [shown, setShown] = useState<{ powers?: string; consents?: string; accepted?: string }>({});

  function toggle(code: string) {
    const next = form.powers.includes(code) ? form.powers.filter((c) => c !== code) : [...form.powers, code];
    onChange({ ...form, powers: next });
    setShown((s) => ({ ...s, powers: undefined }));
  }

  function next() {
    const m = missing(view, form);
    setShown(m);
    if (Object.keys(m).length === 0) onContinue();
  }

  function draw(b: ViewBlock) {
    switch (b.type) {
      case 'issuerHeader':
        return (
          <div key={b.id} className="letter-head">
            <p className="muted small">
              {b.legalName}
              {b.registryCode ? ` · Código de registro ${b.registryCode}` : ''} · Ref. {view.reference}
            </p>
            {b.date && <p className="muted small letter-date">{b.date}</p>}
          </div>
        );
      case 'title':
        return <h2 key={b.id} className="letter-title"><Rich text={b.text} /></h2>;
      case 'heading':
        return <h3 key={b.id} className="letter-heading"><Rich text={b.text} /></h3>;
      case 'paragraph':
        return (
          <p key={b.id} className={`block-par${b.small ? ' muted small' : ''}`} style={{ textAlign: b.align, fontWeight: b.bold ? 700 : undefined }}>
            <Rich text={b.text} />
          </p>
        );
      case 'list':
        if (b.style === 'letters') {
          return (
            <ol key={b.id} className="data-list" type="A">
              {b.items.map((s, i) => (
                <li key={i}><Rich text={s} /></li>
              ))}
            </ol>
          );
        }
        return (
          <ul key={b.id} className={b.style === 'check' ? 'check-list' : 'bullet-list'}>
            {b.items.map((s, i) => (
              <li key={i}><Rich text={s} /></li>
            ))}
          </ul>
        );
      case 'powers': {
        const maxLen = b.observation.maxLength;
        return (
          <div key={b.id}>
            {b.intro && <p className="block-par"><Rich text={b.intro} /></p>}
            {b.items.length > 0 && (
              <fieldset className={`powers${shown.powers ? ' invalid' : ''}`}>
                <legend className="sr-only">Facultades</legend>
                {b.items.map((p) => (
                  <label key={p.code} className="check">
                    <input type="checkbox" checked={form.powers.includes(p.code)} onChange={() => toggle(p.code)} />
                    <span><Rich text={p.text} /></span>
                  </label>
                ))}
              </fieldset>
            )}
            {shown.powers && <p className="error" role="alert">{shown.powers}</p>}
            {b.observation.enabled && (
              <>
                <label htmlFor="obs">{b.observation.label}</label>
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
              </>
            )}
          </div>
        );
      }
      case 'consent': {
        const marked = form.consents.includes(b.code);
        const bad = Boolean(shown.consents) && b.required && !marked;
        return (
          <div key={b.id} className={`accept consent${bad ? ' invalid' : ''}`}>
            <label className="check">
              <input
                type="checkbox"
                checked={marked}
                onChange={(e) => {
                  onChange({ ...form, consents: e.target.checked ? [...form.consents, b.code] : form.consents.filter((c) => c !== b.code) });
                  setShown((s) => ({ ...s, consents: undefined }));
                }}
              />
              <span>
                <Rich text={b.text} />
                {b.required ? '' : ' (opcional)'}
              </span>
            </label>
            {bad && <p className="error" role="alert">{shown.consents}</p>}
          </div>
        );
      }
      case 'signerBox':
        return (
          <div key={b.id} className="signer-box">
            <strong>{b.title}</strong>
            <div>Nombre: <strong>{b.name}</strong></div>
            <div>Documento: <strong>{b.document}</strong></div>
          </div>
        );
      case 'signatureStamp':
        // En el PDF marca dónde va la constancia de la firma; en pantalla la aceptación va SIEMPRE al final,
        // después de todos los anexos, para que no se pueda aceptar sin haberlos tenido delante.
        return null;
      case 'annex':
        return (
          <details key={b.id} className="annex">
            <summary>{b.title} (léalo antes de firmar)</summary>
            {b.subtitle && <p className="muted small">{b.subtitle}</p>}
            <div className="annex-text"><Rich text={b.text} /></div>
          </details>
        );
      case 'pageBreak':
        return <hr key={b.id} className="block-break" />;
    }
  }

  return (
    <section className="card letter">
      {view.blocks.map(draw)}
      {view.footer && (
        <p className="doc-footer muted small">
          <Rich text={view.footer} />
        </p>
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
