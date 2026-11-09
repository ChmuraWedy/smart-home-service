import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import { labelFor } from '../controls';
import type { Capability, HomeApi, LocalDevice } from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { Icon } from './ui/icon';

function numberField(data: FormData, name: string) {
  const value = String(data.get(name) ?? '').trim();
  return value ? Number(value) : null;
}

export default function LocalDeviceMappings({
  api, device, disabled, onSetup, onSaved, onAuthError,
}: {
  api: HomeApi;
  device: LocalDevice;
  disabled: boolean;
  onSetup?: () => void;
  onSaved: (device: LocalDevice) => void;
  onAuthError: () => void;
}) {
  const [edit, setEdit] = useState<{ code: string; mapping: Capability }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();

  function beginEdit(key: string, mapping: Capability) {
    setError('');
    setEdit({ code: key, mapping });
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
    setBusy(true);
    setError('');
    try {
      const updated = await api.editLocalMapping(device.id, code, mapping, next);
      onSaved(updated);
      setEdit(undefined);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES));
    } finally {
      setBusy(false);
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
      {edit && (
        <form key={edit.code} aria-label={labelFor(edit.code)} onSubmit={save}>
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
                    defaultValue={edit.mapping.minimum ?? undefined}
                  />
                </label>
                <label htmlFor={`${formId}-maximum`}>
                  {t(MSG.MAXIMUM_VALUE)}
                  <input
                    id={`${formId}-maximum`}
                    name="maximum"
                    type="number"
                    step="any"
                    defaultValue={edit.mapping.maximum ?? undefined}
                  />
                </label>
                <label htmlFor={`${formId}-step`}>
                  {t(MSG.STEP)}
                  <input
                    id={`${formId}-step`}
                    name="step"
                    type="number"
                    step="any"
                    defaultValue={edit.mapping.step ?? undefined}
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
