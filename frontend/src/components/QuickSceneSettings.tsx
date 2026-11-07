import { useState } from 'react';
import { sameValue } from '../controls';
import type { ControlSpec } from '../controls';
import type { HomeApi, Reading } from '../home-api';
import { MSG, t } from '../i18n';
import { readSimpleScene } from '../light-scenes';
import type { LightScene, SavedLightScene, ScenePresetInput } from '../light-scenes';
import type { LightPresetLibrary } from '../use-light-presets';
import { usePendingDeviceValue } from '../use-pending-device-value';
import BulbSceneEditor, { effectLabels, SceneSwatch } from './BulbSceneEditor';

export default function QuickSceneSettings({
  library, tuyaApi, scope, spec, reading, disabled, send,
}: {
  library: LightPresetLibrary;
  tuyaApi?: HomeApi;
  scope: string;
  spec: ControlSpec;
  reading?: Reading;
  disabled: boolean;
  send: (scene: LightScene) => Promise<boolean>;
}) {
  const { target, begin } = usePendingDeviceValue(scope, spec.key, reading);
  const current = readSimpleScene(reading?.known ? reading.value : undefined, spec);
  const [edit, setEdit] = useState<SavedLightScene>();
  const [error, setError] = useState(false);

  async function remove(preset: SavedLightScene) {
    try {
      await library.remove(preset);
      setError(false);
    } catch {
      setError(true);
    }
  }

  async function save(preset: ScenePresetInput) {
    await library.save(preset, edit?.name ? edit : undefined);
    setEdit(undefined);
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
          <button type="button" className="secondary compact" disabled={!library.ready} onClick={() => setEdit({ name: '', scene: current })}>
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
      {library.presets.length > 0 && (
        <ul className="bulb-scene-presets">
          {library.presets.map((preset) => (
            <li key={preset.id ?? preset.name}>
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
              <button type="button" className="secondary compact" disabled={!library.ready} onClick={() => setEdit(preset)}>{t(MSG.EDIT)}</button>
              <button type="button" className="secondary compact" onClick={() => remove(preset)}>
                {t(MSG.DELETE)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="help">{t(MSG.LIGHT_SCENES_SAVED_ON_SERVER)}</p>
      {(error || library.failed) && <p className="field-error" role="alert">{t(MSG.COULD_NOT_COMPLETE_THE_ACTION)}</p>}
      {edit && (
        <BulbSceneEditor
          initial={edit}
          tuyaApi={tuyaApi}
          onClose={() => setEdit(undefined)}
          onSave={(preset) => save(preset)}
        />
      )}
    </section>
  );
}
