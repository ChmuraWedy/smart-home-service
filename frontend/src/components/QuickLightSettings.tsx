import type { ReactNode } from 'react';
import type { JsonValue } from '../api';
import { useAutomaticControls } from '../control-drafts';
import { optionLabel } from '../controls';
import type { ControlSpec } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import { usePendingDeviceValue } from '../use-pending-device-value';
import { supportsSimpleScenes } from '../light-scenes';
import QuickSceneSettings from './QuickSceneSettings';
import QuickColorSettings from './QuickColorSettings';
import { CapabilityField } from './DeviceControls';

function modeCaption(value: JsonValue) {
  if (value === 'white') return MSG.LIGHT_MODE_WHITE;
  return value === 'scene' ? MSG.SCENE : MSG.COLOR;
}

function fallbackMode(white: ControlSpec[], color?: ControlSpec, scene?: ControlSpec) {
  if (white.length) return 'white';
  if (color) return 'colour';
  return scene ? 'scene' : undefined;
}

export default function QuickLightSettings({
  power, deviceId, mode, white, color, scene, scope, reading, now, local, disabled, send,
}: {
  power: ReactNode;
  deviceId: string;
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
      <div className="dashboard-sheet-light-toolbar">
        <div className="dashboard-sheet-power">{power}</div>
        {choices.length > 0 && (
          <div className="light-segments" role="group" aria-label={t(MSG.MODE)}>
            {choices.map((value) => (
              <button
                key={String(value)}
                type="button"
                title={optionLabel(value, mode?.key)}
                aria-label={optionLabel(value, mode?.key)}
                aria-pressed={active === value}
                disabled={disabled}
                onClick={() => selectMode(value)}
              >
                {t(modeCaption(value))}
              </button>
            ))}
          </div>
        )}
      </div>
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
      {colorMode && color && (
        <QuickColorSettings
          scope={scope}
          capability={color.key}
          reading={reading(color)}
          disabled={disabled}
          send={(value) => send(color, value)}
        />
      )}
      {active === 'scene' && scene && (supportsSimpleScenes(scene) ? (
        <QuickSceneSettings
          key={deviceId}
          deviceId={deviceId}
          scope={scope}
          spec={scene}
          reading={reading(scene)}
          disabled={disabled}
          send={(value) => send(scene, value)}
          advanced={editor(scene)}
        />
      ) : editor(scene))}
    </>
  );
}
