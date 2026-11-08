import { MSG, t, translateText } from "../i18n";
import { useRef, useState } from 'react';
import { Icon, IconGlyph } from './ui/icon';
export function validDeviceAlias(value: string) {
  return /^[\p{L}][\p{L}\p{M}\p{N} ._-]*$/u.test(value);
}

export function AliasRow({ aliases, disabled, onSave, maxAliases = 32, maxLength = 64, validate, label, displayAlias }: {
  aliases: string[]; disabled: boolean; onSave: (values: string[]) => Promise<void>;
  maxAliases?: number; maxLength?: number; validate?: (value: string) => boolean; label?: string; displayAlias?: (alias: string) => string;
}) {
  const [editing, setEditing] = useState<number | null>(null), [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const folded = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase();
  async function save(values: string[]) {
    if (disabled || lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { await onSave(values); setEditing(null); setDraft(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_SAVE_THE_ALIAS)); }
    finally { lock.current = false; setSaving(false); }
  }
  const editor = editing !== null && (
  <form key="editing-alias" className="alias-tag alias-inline-form" aria-label={t(MSG.EDIT_ALIAS_DIALOG)} onSubmit={event => {
      event.preventDefault(); const value = draft.normalize('NFC').trim();
      if (!value || value.length > maxLength || /[\p{Cc}\p{Cf}]/u.test(value) || (validate && !validate(value))) { setError(t(MSG.ENTER_AN_ALIAS_STARTING_WITH_A_LETTER)); return; }
      if (aliases.some((alias, index) => index !== editing && folded(alias) === folded(value))) { setError(t(MSG.THIS_ALIAS_ALREADY_EXISTS)); return; }
      void save(editing === aliases.length ? [...aliases, value] : aliases.map((alias, index) => index === editing ? value : alias));
    }}
  >
    <input autoFocus aria-label={editing === aliases.length ? t(MSG.NEW_ALIAS) : t(MSG.EDIT_ALIAS)} value={draft} size={Math.max(4, [...draft].length + 2)} maxLength={maxLength} disabled={disabled || saving} onChange={event => { setDraft(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) setEditing(null); } }} />
    <button type="submit" className="alias-icon alias-save" aria-label={t(MSG.SAVE)} title={t(MSG.SAVE)} disabled={disabled || saving || !draft.trim()}>
      <Icon name="check" />
    </button>
    {editing < aliases.length && (
    <button type="button" className="alias-icon" aria-label={t(MSG.DELETE)} title={t(MSG.DELETE)} disabled={disabled || saving} onClick={() => void save(aliases.filter((_, index) => index !== editing))}>
      <Icon name="delete" />
    </button>
)}
    <button type="button" className="alias-icon" aria-label={t(MSG.CANCEL)} title={t(MSG.CANCEL)} disabled={saving} onClick={() => { setEditing(null); setError(''); }}>
      <Icon name="close" />
    </button>
  </form>
);
  return (
    <div className="alias-row" role="group" aria-label={t(MSG.ALIASES)}>
      {label && <span className="alias-label">{label}</span>}
      {aliases.map((alias, index) => editing === index ? editor : (
        <span className="alias-tag" key={alias}>{displayAlias?.(alias) ?? alias}
          <button type="button" className="alias-icon" aria-label={t(MSG.EDIT_ALIAS_PREFIX) + (displayAlias?.(alias) ?? alias)} title={t(MSG.EDIT_ALIAS)} disabled={disabled || saving} onClick={() => { setEditing(index); setDraft(alias); setError(''); }}>
            <Icon name="edit" />
          </button>
        </span>
))}
      {editing === null && aliases.length < maxAliases && (
      <button type="button" className="secondary alias-add" aria-label={t(MSG.ADD_ALIAS)} title={t(MSG.ADD_ALIAS)} disabled={disabled || saving} onClick={() => { setEditing(aliases.length); setDraft(''); setError(''); }}>
        <IconGlyph name="add" />
      </button>
)}
      {editing === aliases.length && editor}
      {error && <p role="alert" className="field-error">{translateText(error)}</p>}
    </div>
  );
}
