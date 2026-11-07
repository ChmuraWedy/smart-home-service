import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import type { LightScene, SavedLightScene } from '../light-scenes';
import { usePendingDeviceValue } from '../use-pending-device-value';

export default function LightPresetMenu({
  presets, scope, capability, reading, disabled, send,
}: {
  presets: SavedLightScene[];
  scope: string;
  capability?: string;
  reading?: Reading;
  disabled: boolean;
  send: (scene: LightScene) => Promise<boolean>;
}) {
  const { begin } = usePendingDeviceValue(scope, capability ?? 'scene_data_v2', reading);

  async function select(value: string) {
    const preset = presets.find(({ name }) => name === value);
    if (!preset || !capability || disabled) return;
    const accept = begin(preset.scene);
    if (await send(preset.scene)) accept();
  }

  return (
    <select
      className="dashboard-light-presets"
      aria-label={t(MSG.PRESETS)}
      disabled={disabled || !presets.length}
      value=""
      onChange={(event) => select(event.currentTarget.value)}
    >
      <option value="">{t(MSG.PRESETS)}</option>
      {presets.map(({ name }) => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}
