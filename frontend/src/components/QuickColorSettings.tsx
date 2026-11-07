import { useRef, useState } from 'react';
import type { JsonValue } from '../api';
import { limitsOf, sameValue } from '../controls';
import type { HSV } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import { usePendingDeviceValue } from '../use-pending-device-value';
import { LightColorWheel } from './LightColorWheel';

function colorValue(value: JsonValue | undefined): HSV | undefined {
  const { h, s, v } = limitsOf(value);
  if (typeof h !== 'number' || typeof s !== 'number' || typeof v !== 'number') return undefined;
  return { h, s, v };
}

export default function QuickColorSettings({
  scope, capability, reading, disabled, send,
}: {
  scope: string;
  capability: string;
  reading?: Reading;
  disabled: boolean;
  send: (value: JsonValue) => Promise<boolean>;
}) {
  const { target, begin } = usePendingDeviceValue(scope, capability, reading);
  const current = colorValue(target?.value ?? (reading?.known ? reading.value : undefined));
  const [draft, setDraft] = useState<HSV>();
  const edited = useRef<HSV | undefined>(undefined);

  function change(value: HSV) {
    edited.current = value;
    setDraft(value);
  }

  function cancel() {
    edited.current = undefined;
    setDraft(undefined);
  }

  async function commit() {
    const value = edited.current;
    edited.current = undefined;
    if (!value) return;
    if (disabled || sameValue(value, current ?? null)) {
      setDraft(undefined);
      return;
    }
    const accept = begin(value);
    try {
      if (await send(value)) accept();
    } finally {
      setDraft(undefined);
    }
  }

  const color = draft ?? current;
  if (!color) return <p className="help">{t(MSG.NO_DATA)}</p>;
  return (
    <section aria-label={t(MSG.COLOR)}>
      <LightColorWheel
        value={color}
        disabled={disabled}
        onChange={(value) => change(value)}
        onCommit={() => commit()}
        onCancel={() => cancel()}
      />
      {target && <p className="sr-only" role="status">{t(MSG.WAITING_FOR_A_NEW_READING)}</p>}
    </section>
  );
}
