import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { validateControlValue } from './controls';
import type { ControlSpec } from './controls';
import type { HomeApi } from './home-api';
import { MSG, t } from './i18n';
import { readBrowserLightScenes, readSimpleScene, saveBrowserLightScenes } from './light-scenes';
import type { SavedLightScene, ScenePresetInput } from './light-scenes';

export function useLightPresets(api: HomeApi, device: string, spec: ControlSpec | undefined, onAuthError: () => void) {
  const [remote, setRemote] = useState<SavedLightScene[]>();
  const [legacy, setLegacy] = useState<SavedLightScene[]>([]);
  const [failed, setFailed] = useState(false);
  const enabled = Boolean(spec);
  const latestSpec = useRef(spec);
  latestSpec.current = spec;
  useEffect(() => {
    if (!enabled || !latestSpec.current) return undefined;
    setLegacy(readBrowserLightScenes(device, latestSpec.current));
    const controller = new AbortController();
    setRemote(undefined);
    setFailed(false);
    api.lightPresets(device, controller.signal).then((rows) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(rows)) throw new Error();
      setRemote(rows);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setFailed(true);
    });
    return () => controller.abort();
  }, [api, device, enabled, onAuthError]);

  function removeLegacy(previous: SavedLightScene) {
    if (!spec) return;
    const next = readBrowserLightScenes(device, spec).filter((preset) => preset.name !== previous.name);
    saveBrowserLightScenes(device, next);
    setLegacy(next);
  }

  async function save(preset: ScenePresetInput, previous?: SavedLightScene) {
    if (!spec || !remote) throw new Error(t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    validateControlValue(spec, preset.scene);
    let saved;
    try {
      saved = await api.saveLightPreset(device, preset, previous?.id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      if (failure instanceof ApiError && failure.status === 409) throw new Error(t(MSG.LIGHT_SCENE_NAME_TAKEN));
      throw failure;
    }
    setRemote((rows) => [...(rows ?? []).filter(({ id }) => id !== saved.id), saved]);
    if (previous && previous.id === undefined) {
      try { removeLegacy(previous); } catch { /* The server copy was saved. */ }
    }
  }

  async function remove(preset: SavedLightScene) {
    if (preset.id === undefined) {
      removeLegacy(preset);
      return;
    }
    try {
      await api.deleteLightPreset(device, preset.id);
      setRemote((rows) => rows?.filter(({ id }) => id !== preset.id));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      throw failure;
    }
  }

  const supported = spec ? (remote ?? []).filter((preset) => readSimpleScene(preset.scene, spec)) : [];
  const presets = [...supported, ...legacy.filter(({ name }) => !supported.some((preset) => preset.name === name))];
  return {
    presets, save, remove, ready: remote !== undefined, failed,
  };
}

export type LightPresetLibrary = ReturnType<typeof useLightPresets>;
