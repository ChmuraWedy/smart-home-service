import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { cloudDeviceCache, cloudDeviceKey, readCloudDevice } from './cloud-device-cache';
import type combinedLayout from './combined-layout';
import { isStale } from './controls';
import type { UnifiedDevice } from './devices';
import type { CombinedMemberInput, HomeApi } from './home-api';
import { localDeviceCache, localDeviceKey, readLocalDevice } from './local-device-cache';
import { useAppDispatch } from './store';
import type { AppDispatch, RootState } from './store';

export type ResolvedMember = { member: CombinedMemberInput; device?: UnifiedDevice };

function localReading(state: RootState, api: HomeApi, id: number | undefined) {
  return id === undefined ? undefined : localDeviceCache.endpoints.deviceState.select(localDeviceKey(api, id))(state).data?.reading;
}

function cloudReading(state: RootState, api: HomeApi, entry: ResolvedMember) {
  const { route, device_id: id } = entry.member;
  return route === 'local' ? undefined : cloudDeviceCache.endpoints.deviceSnapshot.select(cloudDeviceKey(api, id, route))(state).data?.snapshot;
}

export function memberOnline(state: RootState, api: HomeApi, entry: ResolvedMember) {
  if (entry.member.route !== 'local') return cloudReading(state, api, entry)?.online ?? entry.device?.cloud[entry.member.route]?.online;
  const local = localReading(state, api, entry.device?.local?.id);
  return local && local.enabled && local.available;
}

function relayPower(state: RootState, api: HomeApi, entry: ResolvedMember, channel: string, now: number) {
  if (!entry.device) return undefined;
  if (entry.member.route !== 'local') {
    const snapshot = cloudReading(state, api, entry);
    const value = snapshot?.status[channel];
    return snapshot?.online && typeof value === 'boolean' ? value : undefined;
  }
  const local = localReading(state, api, entry.device.local?.id);
  const reading = local?.values[channel];
  return local?.enabled && local.available && typeof reading?.value === 'boolean' && !isStale(reading, now, true) ? reading.value : undefined;
}

export function wiredSupply(state: RootState, api: HomeApi, layout: ReturnType<typeof combinedLayout<ResolvedMember>>, now: number) {
  const supplies: Partial<Record<string, boolean>> = Object.create(null);
  // The layout has already excluded cyclic and missing upstream links.
  function walk(entries: ResolvedMember[], upstream: boolean | undefined) {
    for (const entry of entries) {
      const id = entry.member.device_id;
      if (entry.member.power_source) supplies[id] = upstream;
      layout.channels.get(id)?.forEach((children, channel) => {
        const power = relayPower(state, api, entry, channel, now);
        let supplied = power;
        if (upstream === false) supplied = false;
        else if (upstream === undefined && power !== false) supplied = undefined;
        walk(children, supplied);
      });
    }
  }
  walk(layout.roots, true);
  return supplies;
}

export async function refreshCombinedMember(dispatch: AppDispatch, api: HomeApi, entry: ResolvedMember, signal?: AbortSignal) {
  const { route, device_id: id } = entry.member;
  if (route !== 'local') return (await dispatch(readCloudDevice(api, cloudDeviceKey(api, id, route), { refresh: true, signal }))).online;
  if (!entry.device?.local) return false;
  const reading = await dispatch(readLocalDevice(api, entry.device.local.id, true, signal));
  return reading.enabled && reading.available;
}

export function useRestoredWiring(api: HomeApi, members: ResolvedMember[], supplies: Partial<Record<string, boolean>>, paused: boolean, onAuthError: () => void) {
  const dispatch = useAppDispatch();
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const running = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const reads = running.current;
    return () => {
      reads.forEach((controller) => controller.abort());
      reads.clear();
    };
  }, [api]);

  useEffect(() => {
    const cut = members.filter(({ member }) => supplies[member.device_id] === false).map(({ member }) => member.device_id);
    const reads = running.current;
    cut.forEach((id) => {
      reads.get(id)?.abort();
      reads.delete(id);
    });
    if (cut.some((id) => !waiting.has(id))) setWaiting((previous) => new Set([...previous, ...cut]));
    if (paused) return;

    async function reread(entry: ResolvedMember, controller: AbortController) {
      const id = entry.member.device_id;
      const { signal } = controller;
      try {
        const online = await refreshCombinedMember(dispatch, api, entry, signal);
        if (!online && !signal.aborted) {
          // A bulb may still be booting when its upstream relay reports On.
          await new Promise<void>((resolve) => { setTimeout(resolve, 2500); });
          if (!signal.aborted) await refreshCombinedMember(dispatch, api, entry, signal);
        }
      } catch (failure) {
        if (!signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError();
      } finally {
        if (!signal.aborted) {
          reads.delete(id);
          setWaiting((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
      }
    }

    for (const entry of members) {
      const id = entry.member.device_id;
      if (entry.device && supplies[id] === true && waiting.has(id) && !reads.has(id)) {
        const controller = new AbortController();
        reads.set(id, controller);
        reread(entry, controller);
      }
    }
  }, [api, dispatch, members, onAuthError, paused, supplies, waiting]);

  return waiting;
}
