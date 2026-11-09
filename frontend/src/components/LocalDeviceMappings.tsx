import {
  useEffect, useId, useRef, useState,
} from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, CloudFunctions } from '../api';
import { labelFor, limitsOf } from '../controls';
import type { Capability, HomeApi, LocalDevice } from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { Icon } from './ui/icon';

type TimerRange = { minimum: number; maximum: number; step: number };
const timerCode = /^countdown(?:_[1-9][0-9]*)?$/;

function matchingTimerRange(definitions: CloudFunctions, deviceId: string, code: string, mapping: Capability): TimerRange | undefined {
  if (definitions.device_id !== deviceId || !Array.isArray(definitions.functions)) return undefined;
  const point = Number(mapping.dp);
  const matches = definitions.functions.filter((entry) => entry.dp_id === point || entry.dp_ids?.includes(point));
  const [spec] = matches;
  if (matches.length !== 1 || spec.code !== code || spec.type !== 'Integer') return undefined;
  if ((spec.dp_id !== undefined && spec.dp_id !== point) || spec.dp_ids?.some((id) => id !== point)) return undefined;
  const {
    min, max, step, scale = 0, unit = '',
  } = limitsOf(spec.values);
  if (scale !== 0 || (unit !== '' && unit !== 's') || typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') return undefined;
  if (![min, max, step].every(Number.isSafeInteger) || min < 0 || min > max || step <= 0) return undefined;
  if ((mapping.minimum ?? min) > (mapping.maximum ?? max)) return undefined;
  return { minimum: min, maximum: max, step };
}

function numberField(data: FormData, name: string) {
  const value = String(data.get(name) ?? '').trim();
  return value ? Number(value) : null;
}

export default function LocalDeviceMappings({
  api, device, sharingDevice, disabled, onSetup, onSaved, onAuthError,
}: {
  api: HomeApi;
  device: LocalDevice;
  sharingDevice?: CloudDevice;
  disabled: boolean;
  onSetup?: () => void;
  onSaved: (device: LocalDevice) => void;
  onAuthError: () => void;
}) {
  const [edit, setEdit] = useState<{ code: string; mapping: Capability; suggestion?: TimerRange }>();
  const [operation, setOperation] = useState<'lookup' | 'save'>();
  const busy = operation !== undefined;
  const [error, setError] = useState('');
  const formId = useId();
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => () => lookup.current?.abort(), []);

  async function beginEdit(key: string, mapping: Capability) {
    setError('');
    const { dp } = mapping;
    const needsRange = mapping.minimum == null || mapping.maximum == null || mapping.step == null;
    if (!dp || mapping.type !== 'integer' || !timerCode.test(key) || !needsRange || sharingDevice?.id !== device.device_id) {
      setEdit({ code: key, mapping });
      return;
    }
    const cached = sharingDevice.controls?.definitions;
    const suggested = cached && matchingTimerRange(cached, device.device_id, key, mapping);
    if (suggested) {
      setEdit({ code: key, mapping, suggestion: suggested });
      return;
    }

    const controller = new AbortController();
    lookup.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    setEdit(undefined);
    setOperation('lookup');
    let suggestion: TimerRange | undefined;
    try {
      const definitions = await api.deviceFunctions(device.device_id, 'sharing', controller.signal);
      suggestion = matchingTimerRange(definitions, device.device_id, key, mapping);
    } catch (failure) {
      if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError();
    } finally {
      window.clearTimeout(timeout);
      if (lookup.current === controller) {
        lookup.current = null;
        setOperation(undefined);
        setEdit({ code: key, mapping, suggestion });
      }
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || busy || disabled) return;
    const form = new FormData(event.currentTarget);
    const { code, mapping } = edit;
    const next = { ...mapping, dp: String(form.get('dp')), writable: form.has('writable') };
    if (mapping.type === 'integer' || mapping.type === 'number') {
      next.minimum = numberField(form, 'minimum');
      next.maximum = numberField(form, 'maximum');
      next.step = numberField(form, 'step');
    }
    setOperation('save');
    setError('');
    try {
      const updated = await api.editLocalMapping(device.id, code, mapping, next);
      onSaved(updated);
      setEdit(undefined);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES));
    } finally {
      setOperation(undefined);
    }
  }

  return (
    <details className="cloud-properties">
      <summary>{t(MSG.LOCAL_MAPPINGS_AND_COMMANDS)}</summary>
      {onSetup && (
        <button type="button" className="secondary compact" disabled={disabled || busy || !device.enabled} onClick={onSetup}>
          {t(MSG.SET_UP_FUNCTIONS)}
        </button>
      )}
      <ul>
        {Object.entries(device.capabilities).map(([name, mapping]) => (
          <li key={name}>
            <strong>{labelFor(name)}</strong>
            {' · '}
            <code>{name}</code>
            {mapping.dp && ` · DP ${mapping.dp}`}
            {` · ${t(mapping.writable ? MSG.COMMANDS : MSG.READ_ONLY)}`}
            {mapping.dp && (
              <button
                type="button"
                className="secondary compact"
                aria-label={t(MSG.EDIT_LOCAL_MAPPING, [labelFor(name)])}
                disabled={disabled || busy}
                onClick={() => beginEdit(name, mapping)}
              >
                <Icon name="edit" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {operation === 'lookup' && <p role="status">{t(MSG.LOADING)}</p>}
      {edit && (
        <form key={edit.code} aria-label={labelFor(edit.code)} onSubmit={save}>
          {edit.suggestion && <p className="help">{t(MSG.TIMER_RANGE_SUGGESTED_BY_SMART_LIFE)}</p>}
          <fieldset disabled={disabled || busy} className="survey-form-grid">
            <legend>{labelFor(edit.code)}</legend>
            <label htmlFor={`${formId}-dp`}>
              DP
              <input
                id={`${formId}-dp`}
                name="dp"
                inputMode="numeric"
                pattern="[1-9][0-9]{0,4}"
                required
                defaultValue={edit.mapping.dp}
              />
            </label>
            <label htmlFor={`${formId}-writable`}>
              {t(MSG.ALLOW_COMMANDS)}
              <input id={`${formId}-writable`} name="writable" type="checkbox" defaultChecked={edit.mapping.writable} />
            </label>
            {(edit.mapping.type === 'integer' || edit.mapping.type === 'number') && (
              <>
                <label htmlFor={`${formId}-minimum`}>
                  {t(MSG.MINIMUM_VALUE)}
                  <input
                    id={`${formId}-minimum`}
                    name="minimum"
                    type="number"
                    step="any"
                    defaultValue={edit.mapping.minimum ?? edit.suggestion?.minimum}
                  />
                </label>
                <label htmlFor={`${formId}-maximum`}>
                  {t(MSG.MAXIMUM_VALUE)}
                  <input
                    id={`${formId}-maximum`}
                    name="maximum"
                    type="number"
                    step="any"
                    defaultValue={edit.mapping.maximum ?? edit.suggestion?.maximum}
                  />
                </label>
                <label htmlFor={`${formId}-step`}>
                  {t(MSG.STEP)}
                  <input
                    id={`${formId}-step`}
                    name="step"
                    type="number"
                    step="any"
                    defaultValue={edit.mapping.step ?? edit.suggestion?.step}
                  />
                </label>
              </>
            )}
          </fieldset>
          {error && <p role="alert" className="field-error">{translateText(error)}</p>}
          <div className="actions">
            <button type="button" className="secondary compact" disabled={busy} onClick={() => setEdit(undefined)}>{t(MSG.CANCEL)}</button>
            <button type="submit" className="compact" disabled={disabled || busy}>{t(MSG.SAVE)}</button>
          </div>
        </form>
      )}
    </details>
  );
}
