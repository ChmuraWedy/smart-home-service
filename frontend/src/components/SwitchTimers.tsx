import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ControlSpec } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import {
  decodeInching, encodeInching, maximumInchingSeconds, validInchingSeconds,
} from '../switch-inching';
import type { InchingSetting } from '../switch-inching';
import { usePendingDeviceValue } from '../use-pending-device-value';
import { Switch } from './ui/switch';

export function switchTimerControls(specs: ControlSpec[]): {
  channels: number[];
  countdowns: ControlSpec[];
  inching?: ControlSpec;
} {
  const relays = specs.filter((spec) => spec.kind === 'boolean' && /^(switch|switch_[1-9][0-9]*)$/.test(spec.key));
  const channels = [...new Set(relays.map((spec) => (spec.key === 'switch' ? 1 : Number(spec.key.slice(7)))))].sort((a, b) => a - b);
  if (!channels.length) return { channels, countdowns: [] };
  const countdowns = specs.filter((spec) => spec.kind === 'number' && /^countdown(?:_[1-9][0-9]*)?$/.test(spec.key));
  const inching = specs.find((spec) => spec.key === 'switch_inching' && ['text', 'raw'].includes(spec.kind));
  return { channels, countdowns, inching };
}

type DraftRow = Omit<InchingSetting, 'seconds'> & { seconds: string };
type InchingDraft = { source: string; rows: DraftRow[] };

export function InchingControl({
  spec, channels, reading, pendingScope, disabled, onSend,
}: {
  spec: ControlSpec;
  channels: number[];
  reading?: Reading;
  pendingScope: string;
  disabled: boolean;
  onSend: (value: string) => Promise<boolean | void>;
}) {
  const [draft, setDraft] = useState<InchingDraft>();
  const formId = useId();
  const { target, begin } = usePendingDeviceValue(pendingScope, spec.key, reading);
  const value = target?.value ?? (reading?.known ? reading.value : undefined);
  const raw = typeof value === 'string' ? value : undefined;
  const settings = raw === undefined ? undefined : decodeInching(raw, channels);
  const currentDraft = draft?.source === raw ? draft : undefined;
  const initialRows = settings?.length === 0 ? [{ slot: 0, enabled: false, seconds: '' }] : settings?.map((row) => ({ ...row, seconds: String(row.seconds) }));
  const rows = currentDraft?.rows ?? initialRows;
  const canEdit = spec.writable && !disabled && !target && Boolean(rows);
  const valid = rows?.every(({ seconds }) => validInchingSeconds(Number(seconds)));

  function edit(index: number, change: Partial<Pick<DraftRow, 'enabled' | 'seconds'>>) {
    if (!rows || raw === undefined) return;
    setDraft({ source: raw, rows: rows.map((row, position) => (position === index ? { ...row, ...change } : row)) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentDraft || !canEdit || !valid) return;
    const next = encodeInching(currentDraft.rows.map((row) => ({ ...row, seconds: Number(row.seconds) })));
    if (next !== raw) {
      const accept = begin(next);
      if (await onSend(next) !== true) return;
      accept();
    }
    setDraft(undefined);
  }

  return (
    <section className="capability" aria-label={t(MSG.INCHING)}>
      <h3>{t(MSG.INCHING)}</h3>
      <p className="help">{t(MSG.INCHING_DESCRIPTION)}</p>
      {rows ? (
        <form className="inching-settings" onSubmit={submit}>
          {rows.map((row, index) => (
            <div className="inching-setting" key={row.slot}>
              <label className="inching-toggle" htmlFor={`${formId}-enabled-${row.slot}`}>
                <Switch
                  id={`${formId}-enabled-${row.slot}`}
                  checked={row.enabled}
                  disabled={!canEdit}
                  onChange={(enabled) => edit(index, { enabled })}
                />
                <span>{t(MSG.CHANNEL, [channels[index]])}</span>
              </label>
              <label htmlFor={`${formId}-seconds-${row.slot}`}>
                {t(MSG.INCHING_DELAY_SECONDS)}
                <input
                  id={`${formId}-seconds-${row.slot}`}
                  type="number"
                  min={1}
                  max={maximumInchingSeconds}
                  step={1}
                  required
                  value={row.seconds}
                  disabled={!canEdit}
                  onChange={(event) => edit(index, { seconds: event.currentTarget.value })}
                />
              </label>
            </div>
          ))}
          {spec.writable && (
            <button className="compact apply-control" type="submit" disabled={!canEdit || !currentDraft || !valid}>
              {t(MSG.APPLY)}
            </button>
          )}
        </form>
      ) : <p className="help">{t(raw === undefined ? MSG.NO_DATA : MSG.INCHING_FORMAT_UNAVAILABLE)}</p>}
      {target && <p className="help" role="status">{t(MSG.WAITING_FOR_A_NEW_READING)}</p>}
      {draft && !currentDraft && !target && <p className="help">{t(MSG.INCHING_REPORT_CHANGED)}</p>}
    </section>
  );
}

export function SwitchTimers({ countdowns, renderCountdown, inching }: {
  countdowns: ControlSpec[];
  renderCountdown: (spec: ControlSpec) => ReactNode;
  inching?: ReactNode;
}) {
  if (!countdowns.length && !inching) return null;
  return (
    <section className="switch-timers light-schedules" aria-label={t(MSG.SWITCH_TIMERS)}>
      <h3>{t(MSG.SWITCH_TIMERS)}</h3>
      {countdowns.length > 0 && <h4>{t(MSG.SWITCH_COUNTDOWN)}</h4>}
      <div className="capability-grid">
        {countdowns.map(renderCountdown)}
        {inching}
      </div>
    </section>
  );
}
