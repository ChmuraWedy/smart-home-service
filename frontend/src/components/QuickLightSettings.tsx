import type { JsonValue } from '../api';
import { useAutomaticControls } from '../control-drafts';
import { optionLabel } from '../controls';
import type { ControlSpec } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import { usePendingDeviceValue } from '../use-pending-device-value';
import { CapabilityField } from './DeviceControls';

function fallbackMode(white: ControlSpec[], color?: ControlSpec, scene?: ControlSpec) {
  if (white.length) return 'white';
  if (color) return 'colour';
  return scene ? 'scene' : undefined;
}

export default function QuickLightSettings({
  mode, white, color, scene, scope, reading, now, local, disabled, send,
}: {
  mode?: ControlSpec;
  white: ControlSpec[];
  color?: ControlSpec;
  scene?: ControlSpec;
  scope: string;
  reading: (spec: ControlSpec) => Reading | undefined;
  now: number;
  local: boolean;
  disabled: boolean;
  send: (spec: ControlSpec, value: JsonValue) => Promise<boolean>;
}) {
  const reported = mode && reading(mode);
  const { target, begin } = usePendingDeviceValue(scope, mode?.key ?? 'work_mode', reported);
  const active = target?.value ?? (reported?.known ? reported.value : undefined)
    ?? (mode ? undefined : fallbackMode(white, color, scene));
  const choices = (mode?.writable && mode.kind === 'enum' ? mode.choices ?? [] : [])
    .filter((value) => value === 'white' || value === 'colour' || value === 'color' || value === 'scene');
  const colorMode = active === 'colour' || active === 'color';
  const { stage } = useAutomaticControls(async ([change]) => {
    if (!change || change.value === undefined) return false;
    return send(change.spec, change.value);
  }, !disabled);

  async function selectMode(value: JsonValue) {
    if (!mode || active === value) return;
    const accept = begin(value);
    if (await send(mode, value)) accept();
  }

  function editor(spec: ControlSpec) {
    return (
      <CapabilityField
        key={spec.key}
        pendingScope={scope}
        spec={spec}
        reading={reading(spec)}
        now={now}
        local={local}
        disabled={disabled}
        stage={stage}
        onSend={(value) => send(spec, value)}
      />
    );
  }

  return (
    <>
      {choices.length > 0 && (
        <div className="dashboard-sheet-modes" role="group" aria-label={t(MSG.MODE)}>
          {choices.map((value) => (
            <button
              key={String(value)}
              type="button"
              className="secondary compact"
              aria-pressed={active === value}
              disabled={disabled}
              onClick={() => selectMode(value)}
            >
              {optionLabel(value, mode?.key)}
            </button>
          ))}
        </div>
      )}
      {mode && active != null && !choices.some((value) => value === active) && <p className="help">{t(MSG.MODE)} · {optionLabel(active, mode.key)}</p>}
      {active === 'white' && white.map((spec) => (
        <CapabilityField
          key={spec.key}
          pendingScope={scope}
          spec={spec}
          reading={reading(spec)}
          now={now}
          local={local}
          quickRange={/^(brightness|bright_value(?:_v2)?)$/.test(spec.key) ? 'brightness' : 'temperature'}
          disabled={disabled}
          onSend={(value) => send(spec, value)}
        />
      ))}
      {colorMode && color && editor(color)}
      {active === 'scene' && scene && editor(scene)}
    </>
  );
}
