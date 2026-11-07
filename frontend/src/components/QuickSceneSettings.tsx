import { useState } from 'react';
import type { ReactNode } from 'react';
import { sameValue, validateControlValue } from '../controls';
import type { ControlSpec } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import { readSavedLightScenes, readSimpleScene, saveLightScenes } from '../light-scenes';
import type { LightScene, SavedLightScene } from '../light-scenes';
import { usePendingDeviceValue } from '../use-pending-device-value';
import BulbSceneEditor, { effectLabels, SceneSwatch } from './BulbSceneEditor';

export default function QuickSceneSettings({
  deviceId, scope, spec, reading, disabled, send, advanced,
}: {
  deviceId: string;
  scope: string;
  spec: ControlSpec;
  reading?: Reading;
  disabled: boolean;
  send: (scene: LightScene) => Promise<boolean>;
  advanced: ReactNode;
}) {
  const { target, begin } = usePendingDeviceValue(scope, spec.key, reading);
  const current = readSimpleScene(reading?.known ? reading.value : undefined, spec);
  const [presets, setPresets] = useState(() => readSavedLightScenes(deviceId, spec));
  const [edit, setEdit] = useState<SavedLightScene>();
  const [error, setError] = useState(false);

  function store(preset?: SavedLightScene, previous?: string) {
    if (preset) validateControlValue(spec, preset.scene);
    const latest = readSavedLightScenes(deviceId, spec);
    if (preset && latest.some(({ name }) => name === preset.name && name !== previous)) throw new Error(t(MSG.LIGHT_SCENE_NAME_TAKEN));
    const next = latest.filter(({ name }) => name !== previous);
    if (preset) next.push(preset);
    saveLightScenes(deviceId, next);
    setPresets(next);
    setEdit(undefined);
    setError(false);
  }

  function remove(name: string) {
    try {
      store(undefined, name);
    } catch {
      setError(true);
    }
  }

  async function apply(scene: LightScene) {
    const accept = begin(scene);
    if (await send(scene)) accept();
  }

  return (
    <section className="bulb-scenes" aria-label={t(MSG.SCENE)}>
      <div className="bulb-scenes-heading">
        <h3>{t(MSG.SCENE)}</h3>
        {current && (
          <button type="button" className="secondary compact" onClick={() => setEdit({ name: '', scene: current })}>
            {t(MSG.ADD_LIGHT_SCENE)}
          </button>
        )}
      </div>
      {current && (
        <p className="help">
          {t(MSG.CURRENT)} · {t(effectLabels[current.scene_units[0].unit_change_mode])}
          {target && <span role="status"> · {t(MSG.WAITING_FOR_A_NEW_READING)}</span>}
        </p>
      )}
      {presets.length > 0 && (
        <ul className="bulb-scene-presets">
          {presets.map((preset) => (
            <li key={preset.name}>
              <div className="scene-preview-swatches">
                <SceneSwatch unit={preset.scene.scene_units[0]} />
              </div>
              <strong>{preset.name}</strong>
              <button
                type="button"
                className="secondary compact"
                disabled={disabled || sameValue(preset.scene, target?.value ?? current ?? null)}
                onClick={() => apply(preset.scene)}
              >
                {t(MSG.APPLY)}
              </button>
              <button type="button" className="secondary compact" onClick={() => setEdit(preset)}>{t(MSG.EDIT)}</button>
              <button type="button" className="secondary compact" onClick={() => remove(preset.name)}>
                {t(MSG.DELETE)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="help">{t(MSG.LIGHT_SCENES_SAVED_IN_BROWSER)}</p>
      {error && <p className="field-error" role="alert">{t(MSG.COULD_NOT_COMPLETE_THE_ACTION)}</p>}
      {edit && <BulbSceneEditor initial={edit} onClose={() => setEdit(undefined)} onSave={(preset) => store(preset, edit.name)} />}
      <details className="light-color-precision">
        <summary>{t(MSG.EFFECTS_AND_ADVANCED_CONTROLS)}</summary>
        {advanced}
      </details>
    </section>
  );
}
