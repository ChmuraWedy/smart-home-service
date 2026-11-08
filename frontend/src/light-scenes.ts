import type { JsonValue } from './api';
import type { ControlSpec, HSV } from './controls';
import { limitsOf } from './controls';
import { MSG } from './i18n';
import { validateObject } from './lighting';

export const sceneEffects = ['static', 'jump', 'gradient'] as const;
export type SceneEffect = typeof sceneEffects[number];
export const sceneEffectLabels = {
  static: MSG.SCENE_STATIC,
  jump: MSG.SCENE_FLASH,
  gradient: MSG.SCENE_BREATHE,
};
export type SceneUnit = HSV & {
  bright: number;
  temperature: number;
  'unit_change_mode': SceneEffect;
  'unit_switch_duration': number;
  'unit_gradient_duration': number;
};
export type LightScene = { 'scene_num': number; 'scene_units': SceneUnit[] };
export type ScenePresetInput = { 'name': string; scene: LightScene; 'tuya_scene_id'?: string | null };
export type SavedLightScene = ScenePresetInput & { id?: number };
export type TuyaSceneReference = { id: string; 'name': string };

export function supportsSimpleScenes(spec: ControlSpec) {
  const { schema } = spec;
  if (spec.key !== 'scene_data_v2' || !schema || Object.keys(schema).length !== 2) return false;
  const slot = schema.scene_num;
  if (!slot || !Number.isInteger(slot.min) || !Number.isInteger(slot.max) || (slot.step ?? 1) !== 1) return false;
  const unit = schema.scene_units;
  if (!unit || Object.keys(unit).length !== 8) return false;
  const { range } = limitsOf(unit.unit_change_mode);
  return Array.isArray(range) && sceneEffects.every((effect) => range.includes(effect)) && Object.entries({
    h: 360,
    s: 1000,
    v: 1000,
    bright: 1000,
    temperature: 1000,
    unit_switch_duration: 100,
    unit_gradient_duration: 100,
  }).every(([key, max]) => {
    const rule = limitsOf(unit[key]);
    return rule.min === 0 && rule.max === max && (rule.step ?? 1) === 1;
  });
}

export function isWhiteUnit(unit: SceneUnit) {
  return unit.h === 0 && unit.s === 0 && unit.v === 0 && (unit.bright > 0 || unit.temperature > 0);
}

export function readSimpleScene(value: JsonValue | undefined, spec: ControlSpec): LightScene | undefined {
  if (!value || !spec.schema) return undefined;
  try {
    validateObject(value, spec.schema);
  } catch {
    return undefined;
  }
  const scene = value as LightScene;
  const [first] = scene.scene_units;
  if (first.unit_change_mode === 'static' && scene.scene_units.length !== 1) return undefined;
  const matches = scene.scene_units.every((unit) => (
    unit.unit_change_mode === first.unit_change_mode
    && unit.unit_switch_duration === first.unit_switch_duration
    && unit.unit_gradient_duration === first.unit_gradient_duration
    && ((unit.bright === 0 && unit.temperature === 0) || isWhiteUnit(unit))
  ));
  return matches ? scene : undefined;
}

export function sceneTiming(scene: LightScene, effect: SceneEffect, speed?: number): LightScene {
  return {
    ...scene,
    scene_units: scene.scene_units.map((unit) => {
      const switchDuration = speed ?? unit.unit_switch_duration;
      const gradientDuration = speed ?? unit.unit_gradient_duration;
      return {
        ...unit,
        unit_change_mode: effect,
        unit_switch_duration: effect === 'static' ? 0 : switchDuration,
        unit_gradient_duration: effect === 'static' ? 0 : gradientDuration,
      };
    }),
  };
}

const keyFor = (device: string) => `smart-home.ui.light-scenes.v1.${encodeURIComponent(device)}`;

export function readBrowserLightScenes(device: string, spec: ControlSpec): SavedLightScene[] {
  try {
    const stored = JSON.parse(localStorage.getItem(keyFor(device)) ?? '[]') as SavedLightScene[];
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry) => typeof entry?.name === 'string' && readSimpleScene(entry.scene, spec));
  } catch {
    return [];
  }
}

export function saveBrowserLightScenes(device: string, scenes: SavedLightScene[]) {
  localStorage.setItem(keyFor(device), JSON.stringify(scenes));
}
