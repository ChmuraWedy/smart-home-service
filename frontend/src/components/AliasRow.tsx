import { useRef, useState } from 'react';

export function Pencil() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z" /><path d="m14 5 5 5" /></svg>;
}
export function AliasRow({ aliases, disabled, onSave, maxAliases = 32, maxLength = 64, validate }: {
  aliases: string[]; disabled: boolean; onSave: (values: string[]) => Promise<void>;
  maxAliases?: number; maxLength?: number; validate?: (value: string) => boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null), [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const folded = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase();
  async function save(values: string[]) {
    if (disabled || lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { await onSave(values); setEditing(null); setDraft(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить алиас.'); }
    finally { lock.current = false; setSaving(false); }
  }
  return <div className="alias-row" role="group" aria-label="Алиасы">
    <span className="alias-row-label">Алиасы:</span>
    {aliases.map((alias, index) => editing === index ? null : <span className="alias-tag" key={alias}>{alias}<button type="button" className="alias-icon" aria-label={'Изменить алиас ' + alias} title="Изменить алиас" disabled={disabled || saving} onClick={() => { setEditing(index); setDraft(alias); setError(''); }}><Pencil /></button></span>)}
    {editing === null && aliases.length < maxAliases && <button type="button" className="secondary alias-add" aria-label="Добавить алиас" title="Добавить алиас" disabled={disabled || saving} onClick={() => { setEditing(aliases.length); setDraft(''); setError(''); }}>+</button>}
    {editing !== null && <form className="alias-inline-form" aria-label="Редактирование алиаса" onSubmit={event => {
      event.preventDefault(); const value = draft.normalize('NFC').trim();
      if (!value || value.length > maxLength || /[\p{Cc}\p{Cf}]/u.test(value) || (validate && !validate(value))) { setError('Введите алиас, начиная с буквы. Можно использовать буквы любого языка, цифры, пробелы и ._-'); return; }
      if (aliases.some((alias, index) => index !== editing && folded(alias) === folded(value))) { setError('Такой алиас уже есть.'); return; }
      void save(editing === aliases.length ? [...aliases, value] : aliases.map((alias, index) => index === editing ? value : alias));
    }}><input autoFocus aria-label={editing === aliases.length ? 'Новый алиас' : 'Изменить алиас'} value={draft} maxLength={maxLength} disabled={disabled || saving} onChange={event => { setDraft(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) setEditing(null); } }} />
      <button type="submit" className="compact" disabled={disabled || saving || !draft.trim()}>Сохранить</button>
      {editing < aliases.length && <button type="button" className="secondary compact" disabled={disabled || saving} onClick={() => void save(aliases.filter((_, index) => index !== editing))}>Удалить</button>}
      <button type="button" className="secondary compact" disabled={saving} onClick={() => { setEditing(null); setError(''); }}>Отмена</button>
    </form>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </div>;
}
