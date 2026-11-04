import { localizeMessages, t } from "../i18n";
import { useState } from 'react';
import type { JsonValue } from '../api';
import { validateControlValue } from '../controls';
import type { ControlSpec } from '../controls';
import { defaultObject } from '../lighting';
import { JsonFields } from './LightingFields';
import { WizardDialog } from './WizardDialog';

const descriptions: Record<string, string> = localizeMessages({
  scene_data: 'Настройте световой эффект. Параметры и формат определяются этой лампой.',
  scene_data_v2: 'Создайте последовательность цветов и переходов. Настройте шаги эффекта и проверьте результат перед сохранением.',
  music_data: 'Настройте команду изменения света в такт музыке. Для непрерывной синхронизации нужен источник аудио, который отправляет такие команды.',
  control_data: 'Выберите быстрый или плавный переход к нужному цвету и яркости. Текущее состояние света отображается в основных параметрах лампы.',
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
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("Проверьте параметры эффекта.")); }
  };
  return <WizardDialog title={spec.label} description={descriptions[spec.key]} onClose={onClose} actions={<>
    {step > 0 && <button className="secondary" type="button" onClick={() => { setStep(0); setError(''); }}>{t("Назад")}</button>}
    <button type="button" onClick={advance}>{step ? t("Готово") : t("Далее")}</button>
  </>}>
    <ol className="wizard-steps" aria-label={t("Этапы настройки")}>{[t("Параметры"), t("Проверка")].map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
    {!step ? <section aria-label={t("Параметры эффекта")}>{spec.kind === 'json' && spec.schema && model ? <JsonFields schema={spec.schema} value={model} prefix={spec.key + '.'} disabled={false} onChange={next => { setDraft(JSON.stringify(next)); setError(''); }} /> : <>
      <p className="help">{spec.schema ? t("Текущее значение не распознано. Исходные данные сохранены.") : t("Лампа не предоставила описание отдельных параметров. Можно изменить данные в формате устройства.")}</p>
      {spec.schema && <button type="button" className="secondary compact" onClick={() => setDraft(JSON.stringify(defaultObject(spec.schema!)))}>{t("Новый эффект")}</button>}
      <label>{spec.kind === 'json' ? t("Данные эффекта — JSON") : spec.kind === 'raw' ? t("Данные производителя (base64)") : t("Данные эффекта")}<textarea value={draft} rows={5} maxLength={spec.kind === 'raw' ? 22000 : spec.kind === 'text' ? 4096 : 16384} onChange={event => { setDraft(event.target.value); setError(''); }} /></label>
    </>}</section> : <section aria-label={t("Проверка эффекта")}><h3>{t("Проверьте параметры")}</h3><div className="wizard-review">{spec.schema && model ? <JsonFields schema={spec.schema} value={model} prefix={spec.key + '.review.'} disabled onChange={() => {}} /> : <pre className="wizard-preview">{model ? JSON.stringify(model, null, 2) : draft}</pre>}</div><p className="help">{t("«Готово» вернёт изменения в карточку. Чтобы отправить их устройству, нажмите общую кнопку «Применить».")}</p></section>}
    {error && <p className="field-error" role="alert">{t(error)}</p>}
  </WizardDialog>;
}
