import { MSG, localizeMessages, t, translateText } from "../i18n";
import { useState } from 'react';
import type { JsonValue } from '../api';
import { validateControlValue } from '../controls';
import type { ControlSpec } from '../controls';
import { defaultObject } from '../lighting';
import { JsonFields } from './LightingFields';
import { WizardDialog } from './WizardDialog';

const descriptions: Record<string, string> = localizeMessages({
  scene_data: MSG.LIGHT_EFFECT_HELP_SCENE_DATA,
  scene_data_v2: MSG.LIGHT_EFFECT_HELP_SCENE_DATA_V2,
  music_data: MSG.LIGHT_EFFECT_HELP_MUSIC_DATA,
  control_data: MSG.LIGHT_EFFECT_HELP_CONTROL_DATA,
});
export const hasLightEffectWizard = (spec: ControlSpec) => !!descriptions[spec.key] && ['json', 'text', 'raw'].includes(spec.kind);

export function LightEffectWizard({ spec, value, onDone, onClose }: { spec: ControlSpec; value: string; onDone: (value: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(() => value || (spec.kind === 'json' && spec.schema ? JSON.stringify(defaultObject(spec.schema)) : ''));
  const [step, setStep] = useState(0), [error, setError] = useState('');
  let model: Record<string, JsonValue> | undefined;
  try { const parsed = JSON.parse(draft); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) model = parsed; } catch { /* Preserve unrecognized data for explicit editing. */ }
  const advance = () => {
    try {
      validateControlValue(spec, spec.kind === 'json' ? JSON.parse(draft) : draft);
      setError('');
      if (!step) setStep(1); else onDone(draft);
    } catch (failure) { setError(failure instanceof Error ? failure.message : t(MSG.CHECK_THE_EFFECT_SETTINGS)); }
  };
  return (
    <WizardDialog title={spec.label} description={descriptions[spec.key]} onClose={onClose}
      actions={(
        <>
          {step > 0 && <button className="secondary" type="button" onClick={() => { setStep(0); setError(''); }}>{t(MSG.BACK)}</button>}
          <button type="button" onClick={advance}>{step ? t(MSG.DONE) : t(MSG.NEXT)}</button>
        </>
)}
    >
      <ol className="wizard-steps" aria-label={t(MSG.SETUP_STEPS)}>
        {[t(MSG.SETTINGS), t(MSG.REVIEW)].map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}>{index + 1}. {title}</li>)}
      </ol>
      {!step ? (
        <section aria-label={t(MSG.EFFECT_SETTINGS)}>
          {spec.kind === 'json' && spec.schema && model ? <JsonFields schema={spec.schema} value={model} prefix={spec.key + '.'} disabled={false} onChange={next => { setDraft(JSON.stringify(next)); setError(''); }} /> : (
            <>
              <p className="help">{spec.schema ? t(MSG.THE_CURRENT_VALUE_WAS_NOT_RECOGNIZED) : t(MSG.THE_BULB_PROVIDED_NO_DESCRIPTION_OF_INDIVIDUAL_PARAMETERS)}</p>
              {spec.schema && <button type="button" className="secondary compact" onClick={() => setDraft(JSON.stringify(defaultObject(spec.schema!)))}>{t(MSG.NEW_EFFECT)}</button>}
              <label>{spec.kind === 'json' ? t(MSG.EFFECT_DATA_JSON) : spec.kind === 'raw' ? t(MSG.MANUFACTURER_DATA_BASE64) : t(MSG.EFFECT_DATA)}
                <textarea value={draft} rows={5} maxLength={spec.kind === 'raw' ? 22000 : spec.kind === 'text' ? 4096 : 16384} onChange={event => { setDraft(event.target.value); setError(''); }} />
              </label>
            </>
    )}
        </section>
) : (
  <section aria-label={t(MSG.REVIEW_EFFECT)}>
    <h3>{t(MSG.CHECK_THE_SETTINGS)}</h3>
    <div className="wizard-review">
      {spec.schema && model ? <JsonFields schema={spec.schema} value={model} prefix={spec.key + '.review.'} disabled onChange={() => {}} /> :
      <pre className="wizard-preview">{model ? JSON.stringify(model, null, 2) : draft}</pre>}
    </div>
    <p className="help">{t(MSG.DONE_SENDS_THE_CHANGES_TO_THE_DEVICE)}</p>
  </section>
  )}
      {error && <p className="field-error" role="alert">{translateText(error)}</p>}
    </WizardDialog>
  );
}
