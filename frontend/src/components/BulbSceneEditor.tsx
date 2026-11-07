import {
  useEffect, useId, useRef, useState,
} from 'react';
import { hsvToHex } from '../controls';
import type { HomeApi } from '../home-api';
import { MSG, t } from '../i18n';
import { isWhiteUnit, sceneEffects, sceneTiming } from '../light-scenes';
import type {
  LightScene, SavedLightScene, SceneEffect, ScenePresetInput, SceneUnit, TuyaSceneReference,
} from '../light-scenes';
import { LightColorWheel, LightRange } from './LightColorWheel';
import { Icon } from './ui/icon';
import { WizardDialog } from './WizardDialog';

export const effectLabels = {
  static: MSG.SCENE_STATIC,
  jump: MSG.SCENE_FLASH,
  gradient: MSG.SCENE_BREATHE,
};

export function SceneSwatch({ unit }: { unit: SceneUnit }) {
  const color = isWhiteUnit(unit)
    ? `hsl(42 90% ${66 + unit.temperature / 32}%)`
    : hsvToHex(unit);
  return <span className="scene-swatch" style={{ backgroundColor: color }} aria-hidden="true" />;
}

export default function BulbSceneEditor({
  initial, tuyaApi, onSave, onClose,
}: {
  initial: SavedLightScene;
  tuyaApi?: HomeApi;
  onSave: (scene: ScenePresetInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [scene, setScene] = useState(initial.scene);
  const [effect, setEffect] = useState(initial.scene.scene_units[0].unit_change_mode);
  const [index, setIndex] = useState(0);
  const [stepIds, setStepIds] = useState(() => initial.scene.scene_units.map((_, i) => i));
  const nextStepId = useRef(stepIds.length);
  const nameId = useId();
  const linkId = useId();
  const [references, setReferences] = useState<TuyaSceneReference[]>([]);
  const [reference, setReference] = useState(initial.tuya_scene_id ?? '');
  const [saving, setSaving] = useState(false);
  const [colorKinds, setColorKinds] = useState(() => initial.scene.scene_units.map(isWhiteUnit));
  const [error, setError] = useState('');
  const unit = scene.scene_units[index];
  const white = colorKinds[index];

  useEffect(() => {
    if (!tuyaApi) return undefined;
    const controller = new AbortController();
    tuyaApi.tuyaSceneReferences(controller.signal).then((rows) => {
      if (!controller.signal.aborted && Array.isArray(rows)) setReferences(rows);
    }).catch(() => {});
    return () => controller.abort();
  }, [tuyaApi]);

  function setUnit(next: SceneUnit) {
    setScene({ ...scene, scene_units: scene.scene_units.map((item, i) => (i === index ? next : item)) });
  }

  function selectEffect(next: SceneEffect) {
    if (next === effect) return;
    setEffect(next);
    if (next !== 'static') {
      const duration = scene.scene_units[0].unit_switch_duration;
      setScene(sceneTiming(scene, next, duration || 50));
    }
  }

  async function save() {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError('');
    const draft = effect === 'static' ? { ...scene, scene_units: [unit] } : scene;
    try {
      await onSave({ name: name.trim(), scene: sceneTiming(draft, effect), tuya_scene_id: reference || null });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    } finally {
      setSaving(false);
    }
  }

  function selectColorKind(next: boolean) {
    if (next === white) return;
    setColorKinds(colorKinds.map((kind, i) => (i === index ? next : kind)));
    if (next) {
      setUnit({
        ...unit, h: 0, s: 0, v: 0, bright: unit.v, temperature: 500,
      });
    } else {
      setUnit({
        ...unit, bright: 0, temperature: 0, v: unit.bright,
      });
    }
  }

  function addStep() {
    setScene({ ...scene, scene_units: [...scene.scene_units, unit] });
    setColorKinds([...colorKinds, white]);
    setStepIds([...stepIds, nextStepId.current]);
    nextStepId.current += 1;
    setIndex(scene.scene_units.length);
  }

  function removeStep(step: number) {
    setScene({ ...scene, scene_units: scene.scene_units.filter((_, i) => i !== step) });
    setColorKinds(colorKinds.filter((_, i) => i !== step));
    setStepIds(stepIds.filter((_, i) => i !== step));
    if (step < index || index >= scene.scene_units.length - 1) setIndex(index - 1);
  }

  return (
    <WizardDialog
      title={t(initial.name ? MSG.EDIT_LIGHT_SCENE : MSG.ADD_LIGHT_SCENE)}
      onClose={onClose}
      actions={(
        <button type="button" disabled={saving || !name.trim()} onClick={() => save()}>
          {t(MSG.SAVE)}
        </button>
      )}
    >
      <label className="field" htmlFor={nameId}>
        {t(MSG.NAME)}
        <input id={nameId} value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      {(references.length > 0 || reference) && (
        <label className="field" htmlFor={linkId}>
          {t(MSG.LIGHT_SCENE_TUYA_REFERENCE)}
          <select id={linkId} value={reference} onChange={(event) => setReference(event.currentTarget.value)}>
            <option value="">{t(MSG.NOT_SET)}</option>
            {reference && !references.some(({ id }) => id === reference) && <option value={reference}>{t(MSG.UNAVAILABLE)}</option>}
            {references.map(({ id, name: label }) => <option value={id} key={id}>{label}</option>)}
          </select>
        </label>
      )}
      <h3>{t(MSG.SCENE_EFFECT)}</h3>
      <div className="light-segments" role="group" aria-label={t(MSG.SCENE_EFFECT)}>
        {sceneEffects.map((option) => (
          <button key={option} type="button" aria-pressed={effect === option} onClick={() => selectEffect(option)}>
            {t(effectLabels[option])}
          </button>
        ))}
      </div>
      {effect !== 'static' && (
        <LightRange
          label={t(MSG.SPEED)}
          max={100}
          suffix="%"
          value={unit.unit_switch_duration}
          onChange={(speed) => setScene(sceneTiming(scene, effect, speed))}
        />
      )}
      <h3>{t(MSG.COLOR)}</h3>
      {effect !== 'static' && (
        <div className="scene-steps" role="group" aria-label={t(MSG.EFFECT_STEPS)}>
          {scene.scene_units.map((step, i) => (
            <div className="scene-step" key={stepIds[i]}>
              <button
                type="button"
                className="secondary compact"
                aria-label={`${t(MSG.STEP)} ${i + 1}`}
                aria-pressed={index === i}
                onClick={() => setIndex(i)}
              >
                <SceneSwatch unit={step} />
              </button>
              {scene.scene_units.length > 1 && (
                <button
                  type="button"
                  className="scene-step-delete secondary"
                  aria-label={`${t(MSG.DELETE_STEP)} ${i + 1}`}
                  onClick={() => removeStep(i)}
                >
                  <Icon name="delete" />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="secondary compact"
            aria-label={t(MSG.ADD_STEP)}
            disabled={scene.scene_units.length >= 32}
            onClick={() => addStep()}
          >
            +
          </button>
        </div>
      )}
      <div className="light-segments" role="group" aria-label={t(MSG.MODE)}>
        <button type="button" aria-pressed={!white} onClick={() => selectColorKind(false)}>{t(MSG.COLOR)}</button>
        <button type="button" aria-pressed={white} onClick={() => selectColorKind(true)}>{t(MSG.LIGHT_MODE_WHITE)}</button>
      </div>
      {white ? (
        <>
          <LightRange
            label={t(MSG.COLOR_TEMPERATURE)}
            max={100}
            step={0.1}
            suffix="%"
            value={unit.temperature / 10}
            onChange={(temperature) => setUnit({ ...unit, temperature: Math.round(temperature * 10) })}
          />
          <LightRange
            label={t(MSG.BRIGHTNESS)}
            max={100}
            step={0.1}
            suffix="%"
            value={unit.bright / 10}
            onChange={(bright) => setUnit({ ...unit, bright: Math.round(bright * 10) })}
          />
        </>
      ) : <LightColorWheel value={unit} onChange={(color) => setUnit({ ...unit, ...color })} />}
      {error && <p className="field-error" role="alert">{error}</p>}
    </WizardDialog>
  );
}
