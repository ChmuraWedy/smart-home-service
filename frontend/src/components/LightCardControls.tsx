import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';
import type { HomeApi, Reading } from '../home-api';
import lightControls from '../light-controls';
import { useLightPresets } from '../use-light-presets';
import { lightCardSummary } from './LightCardReadings';
import LightPresetMenu from './LightPresetMenu';
import QuickLightSettings from './QuickLightSettings';

export default function useLightCardControls({
  api, tuyaApi, deviceId, specs, singlePower, currentReading, reading, now, local, disabled,
  send, scope, onAuthError, presetSlot, onLightFeatures,
}: {
  api: HomeApi;
  tuyaApi?: HomeApi;
  deviceId: string;
  specs: ControlSpec[];
  singlePower: boolean;
  currentReading: (spec: ControlSpec | undefined) => Reading | undefined;
  reading: (spec: ControlSpec) => Reading | undefined;
  now: number;
  local: boolean;
  disabled: boolean;
  send: (spec: ControlSpec, value: JsonValue) => Promise<boolean>;
  scope: string;
  onAuthError: () => void;
  presetSlot?: HTMLDivElement | null;
  onLightFeatures?: (hasQuickSettings: boolean, hasPresets: boolean) => void;
}) {
  const controls = lightControls(specs, singlePower);
  const {
    brightness, temperature, color, white, mode, scene,
  } = controls;
  const library = useLightPresets(api, deviceId, scene, onAuthError);
  const summary = lightCardSummary(controls, currentReading);
  const hasQuickSettings = white.length > 0 || Boolean(color?.writable || scene);
  const hasPresetMenu = Boolean(summary || scene);
  useEffect(() => {
    onLightFeatures?.(hasQuickSettings, hasPresetMenu);
  }, [hasQuickSettings, hasPresetMenu, onLightFeatures]);

  function renderQuick(power: ReactNode) {
    return (
      <QuickLightSettings
        power={power}
        library={library}
        tuyaApi={tuyaApi}
        mode={mode}
        white={white}
        color={color?.writable ? color : undefined}
        scene={scene}
        scope={scope}
        reading={reading}
        now={now}
        local={local}
        disabled={disabled}
        send={send}
      />
    );
  }

  const presetMenu = presetSlot && createPortal(
    <LightPresetMenu
      presets={library.presets}
      scope={scope}
      capability={scene?.key}
      reading={scene && reading(scene)}
      disabled={disabled}
      send={(value) => (scene ? send(scene, value) : Promise.resolve(false))}
    />,
    presetSlot,
  );

  return {
    summary,
    hasQuickSettings,
    renderQuick,
    presetMenu,
    isLightLevel: (spec: ControlSpec) => spec === brightness || spec === temperature,
  };
}
