import { useId, useRef } from 'react';
import type { PointerEvent } from 'react';
import { hsvToHex } from '../controls';
import type { HSV } from '../controls';
import { MSG, t } from '../i18n';

export function LightRange({
  label, value, min = 0, max, step = 1, suffix = '', disabled, onChange, onCommit, onCancel,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}) {
  const id = useId();
  return (
    <label className="dashboard-sheet-range" htmlFor={id}>
      <span>{label}</span>
      <span className="dashboard-sheet-range-value">{value}{suffix}</span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        onPointerCancel={onCancel}
      />
    </label>
  );
}

export function LightColorWheel({
  value, disabled, onChange, onCommit, onCancel,
}: {
  value: HSV;
  disabled?: boolean;
  onChange: (value: HSV) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}) {
  const pointer = useRef<number | null>(null);
  const start = useRef(value);
  const angle = (value.h * Math.PI) / 180;
  const saturation = value.s / 1000;

  function select(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = ((event.clientX - bounds.left) * 2) / bounds.width - 1;
    const y = ((event.clientY - bounds.top) * 2) / bounds.height - 1;
    const radius = Math.hypot(x, y);
    const degrees = (Math.atan2(x, -y) * 180) / Math.PI;
    const h = radius === 0 ? value.h : Math.round((degrees + 360) % 360) % 360;
    onChange({ ...value, h, s: Math.round(Math.min(radius, 1) * 1000) });
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (disabled || pointer.current !== null || event.button !== 0) return;
    event.preventDefault();
    pointer.current = event.pointerId;
    start.current = value;
    event.currentTarget.setPointerCapture(event.pointerId);
    select(event);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current === event.pointerId && !disabled) select(event);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (disabled) return;
    select(event);
    onCommit?.();
  }

  function cancelDrag() {
    if (pointer.current === null) return;
    pointer.current = null;
    if (onCancel) onCancel();
    else onChange(start.current);
  }

  return (
    <div className="light-color-tools">
      <div
        className="light-color-wheel"
        aria-hidden="true"
        data-disabled={disabled || undefined}
        onPointerDown={(event) => startDrag(event)}
        onPointerMove={(event) => moveDrag(event)}
        onPointerUp={(event) => endDrag(event)}
        onLostPointerCapture={() => cancelDrag()}
      >
        <span
          className="light-color-cursor"
          style={{
            left: `${50 + Math.sin(angle) * saturation * 50}%`,
            top: `${50 - Math.cos(angle) * saturation * 50}%`,
            backgroundColor: hsvToHex({ ...value, v: 1000 }),
          }}
        />
      </div>
      <LightRange
        label={t(MSG.BRIGHTNESS)}
        max={100}
        step={0.1}
        suffix="%"
        value={value.v / 10}
        disabled={disabled}
        onChange={(v) => onChange({ ...value, v: Math.round(v * 10) })}
        onCommit={onCommit}
        onCancel={onCancel}
      />
      <details className="light-color-precision">
        <summary>{t(MSG.HUE)} · {t(MSG.SATURATION)}</summary>
        <LightRange
          label={t(MSG.HUE)}
          max={360}
          suffix="°"
          value={value.h}
          disabled={disabled}
          onChange={(h) => onChange({ ...value, h })}
          onCommit={onCommit}
          onCancel={onCancel}
        />
        <LightRange
          label={t(MSG.SATURATION)}
          max={100}
          step={0.1}
          suffix="%"
          value={value.s / 10}
          disabled={disabled}
          onChange={(s) => onChange({ ...value, s: Math.round(s * 10) })}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </details>
    </div>
  );
}
