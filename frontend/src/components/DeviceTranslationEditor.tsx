import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import type { CloudApi, Provider } from '../api';
import { cloudAccountScope } from '../cloud-account-scope';
import {
  cloudMetadataKey, localMetadataKey, nextDeviceMetadataRevision, saveDeviceTranslation,
} from '../device-metadata';
import { translationFor } from '../device-translations';
import type {
  DeviceTranslations, TranslatedText, TranslationEdit, TranslationKind,
} from '../device-translations';
import {
  LANGUAGES, MSG, t, translateText,
} from '../i18n';
import { useAppDispatch, useAppSelector } from '../store';

type Props = {
  api: CloudApi;
  deviceId: string;
  originalName: string;
  initialAliases?: string[];
  translations?: DeviceTranslations;
  provider?: Provider;
  localId?: number;
  onAuthError: () => void;
};
type Entry = { kind: TranslationKind; original: string; key: string };

function TranslationFields({
  entry, values, onSave,
}: {
  entry: Entry;
  values?: TranslatedText;
  onSave: (edit: TranslationEdit) => Promise<void>;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<TranslatedText>(values ?? {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const normalized = Object.fromEntries(Object.entries(draft).map(([locale, value]) => [
    locale, value.normalize('NFC').trim(),
  ]).filter(([, value]) => value !== ''));
  const changed = LANGUAGES.some(({ value }) => normalized[value] !== values?.[value]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setFailed(false);
    setNotice('');
    try {
      await onSave({ kind: entry.kind, original: entry.original, values: normalized });
      setDraft(normalized);
      setNotice(t(MSG.DEVICE_TRANSLATIONS_SAVED));
    } catch (failure) {
      setFailed(true);
      setNotice(failure instanceof Error ? translateText(failure.message) : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="device-translation-form" onSubmit={(event) => submit(event)}>
      <div className="device-translation-inputs">
        {LANGUAGES.map(({ value, label }) => (
          <label key={value} lang={value} htmlFor={`${formId}-${value}`}>
            {label}
            <input
              id={`${formId}-${value}`}
              value={draft[value] ?? ''}
              maxLength={120}
              disabled={busy}
              placeholder={entry.original}
              onChange={(event) => setDraft({ ...draft, [value]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <button type="submit" className="secondary compact" disabled={busy || !changed}>{t(MSG.SAVE_DEVICE_TRANSLATIONS)}</button>
      {notice && <p className={failed ? 'field-error' : 'help'} role={failed ? 'alert' : 'status'}>{notice}</p>}
    </form>
  );
}

export default function DeviceTranslationEditor({
  api, deviceId, originalName, initialAliases = [], translations, provider, localId, onAuthError,
}: Props) {
  const dispatch = useAppDispatch();
  const localKey = localId === undefined ? undefined : localMetadataKey(api, localId);
  const key = provider ? cloudMetadataKey(cloudAccountScope(api, provider), deviceId) : localKey;
  const identity = useAppSelector((state) => (key ? state.deviceMetadata.devices[key] : undefined));
  const aliases = (identity?.aliases?.value ?? initialAliases)
    .filter((alias) => alias.normalize('NFC').toLocaleLowerCase() !== originalName.normalize('NFC').toLocaleLowerCase());
  const saved = identity?.translations?.value ?? translations;
  const entries: Entry[] = [
    { kind: 'name', original: originalName, key: 'name' },
    ...aliases.map((alias) => ({ kind: 'alias' as const, original: alias, key: `alias:${alias}` })),
  ];
  const targetId = useId();
  const [target, setTarget] = useState('name');
  const selected = entries.find((entry) => entry.key === target) ?? entries[0];

  async function save(edit: TranslationEdit) {
    if (!key || (!provider && localId === undefined)) return;
    const scope = provider && cloudAccountScope(api, provider);
    const cloudKeys = (['sharing', 'developer'] as const).map((route) => cloudMetadataKey(cloudAccountScope(api, route), deviceId));
    try {
      const result = provider ? await api.saveDeviceTranslation(deviceId, provider, edit)
        : await api.saveLocalDeviceTranslation(Number(localId), edit);
      if (scope && provider && cloudAccountScope(api, provider) !== scope) return;
      if (result.kind !== edit.kind || result.original !== edit.original || !result.values) {
        throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_DEVICE_DATA));
      }
      const linkedKeys = result.shared && localKey ? [localKey, ...cloudKeys] : [];
      dispatch(saveDeviceTranslation({
        key, linkedKeys, edit: result, initial: saved, revision: nextDeviceMetadataRevision(),
      }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      if (failure instanceof ApiError && failure.status === 409) throw new Error(t(MSG.DEVICE_TRANSLATION_OUTDATED));
      throw failure;
    }
  }

  return (
    <details className="cloud-properties">
      <summary>{t(MSG.DEVICE_LABEL_TRANSLATIONS)}</summary>
      <p className="help">{t(MSG.DEVICE_TRANSLATION_FALLBACK_HELP)}</p>
      <label htmlFor={targetId}>
        {t(MSG.DEVICE_TRANSLATION_ORIGINAL)}
        <select id={targetId} value={selected.key} onChange={(event) => setTarget(event.target.value)}>
          {entries.map(({ key: entryKey, kind, original }) => (
            <option value={entryKey} key={entryKey}>{kind === 'name' ? `${t(MSG.NAME)} · ${original}` : original}</option>
          ))}
        </select>
      </label>
      <TranslationFields
        key={`${selected.kind}:${selected.original}`}
        entry={selected}
        values={translationFor(saved, selected.kind, selected.original)}
        onSave={(edit) => save(edit)}
      />
    </details>
  );
}
