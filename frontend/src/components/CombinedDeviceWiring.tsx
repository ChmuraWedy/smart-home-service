import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api';
import type { CloudFunction } from '../api';
import { labelFor } from '../controls';
import { useDeviceDisplayName } from '../devices';
import type { UnifiedDevice } from '../devices';
import type { CombinedMemberInput, CombinedPowerSource, HomeApi } from '../home-api';
import { MSG, t } from '../i18n';

const relayChannel = /^switch(?:_[1-9][0-9]*)?$/;
const cloudChannels = (functions: CloudFunction[]) => functions
  .filter(({ code, type }) => type === 'Boolean' && relayChannel.test(code))
  .map(({ code }) => code);
const sourceKey = (source: CombinedPowerSource) => JSON.stringify([source.device_id, source.channel]);

export default function CombinedDeviceWiring({
  api, formId, devices, members, disabled, onChange, onAuthError,
}: {
  api: HomeApi;
  formId: string;
  devices: UnifiedDevice[];
  members: CombinedMemberInput[];
  disabled: boolean;
  onChange: (id: string, source: CombinedPowerSource | null) => void;
  onAuthError: () => void;
}) {
  const displayName = useDeviceDisplayName();
  const byId = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
  const [loaded, setLoaded] = useState<Record<string, string[] | null>>({});
  const pending = useMemo(() => members.flatMap(({ device_id: id, route }) => {
    if (route === 'local') return [];
    const device = byId.get(id)?.cloud[route];
    const key = `${route}:${id}`;
    return device && !device.controls?.ready && !Object.hasOwn(loaded, key) ? [{ id, route, key }] : [];
  }), [byId, loaded, members]);

  useEffect(() => {
    if (!pending.length) return undefined;
    const abort = new AbortController();
    const requests = pending.map(async ({ id, route, key }) => {
      try {
        const { functions } = await api.deviceFunctions(id, route, abort.signal);
        return [key, cloudChannels(functions)] as const;
      } catch (error) {
        if (!abort.signal.aborted && error instanceof ApiError && error.status === 401) onAuthError();
        return [key, null] as const;
      }
    });
    Promise.all(requests).then((results) => {
      if (!abort.signal.aborted) setLoaded((current) => ({ ...current, ...Object.fromEntries(results) }));
    });
    return () => abort.abort();
  }, [api, pending, onAuthError]);

  const sources = members.flatMap(({ device_id: id, route }) => {
    const device = byId.get(id);
    if (route === 'local') {
      const channels = Object.entries(device?.local?.capabilities ?? {})
        .filter(([code, spec]) => relayChannel.test(code) && spec.type === 'boolean' && spec.writable)
        .map(([code]) => code);
      return channels.map((channel) => ({ device_id: id, channel }));
    }
    const inventory = device?.cloud[route]?.controls;
    const channels = loaded[`${route}:${id}`] ?? cloudChannels(inventory?.definitions.functions ?? []);
    return channels.map((channel) => ({ device_id: id, channel }));
  });

  return (
    <fieldset className="combined-wiring" disabled={disabled}>
      <legend>{t(MSG.COMBINED_WIRING)}</legend>
      <p className="help">{t(MSG.COMBINED_WIRING_HELP)}</p>
      {Object.values(loaded).includes(null) && <p className="help">{t(MSG.COMBINED_WIRING_LOOKUP_FAILED)}</p>}
      {pending.length > 0 && <p className="help" role="status">{t(MSG.COMBINED_LOADING_WIRING_CHANNELS)}</p>}
      {pending.length === 0 && sources.length === 0 && !members.some((member) => member.power_source) && (
        <p className="help">{t(MSG.COMBINED_NO_WIRING_CHANNELS)}</p>
      )}
      {members.map(({ device_id: id, power_source: source }) => {
        const options = sources.filter((choice) => choice.device_id !== id);
        if (source && !options.some((choice) => sourceKey(choice) === sourceKey(source))) options.push(source);
        if (!options.length) return null;
        const fieldId = `${formId}-wiring-${id}`;
        return (
          <label key={id} className="field" htmlFor={fieldId}>
            {t(MSG.COMBINED_POWER_SOURCE_FOR, [displayName(byId.get(id), id)])}
            <select
              id={fieldId}
              value={source ? sourceKey(source) : ''}
              onChange={(event) => onChange(id, options.find((choice) => sourceKey(choice) === event.target.value) ?? null)}
            >
              <option value="">{t(MSG.COMBINED_NO_POWER_SOURCE)}</option>
              {options.map((choice) => (
                <option value={sourceKey(choice)} key={sourceKey(choice)}>
                  {displayName(byId.get(choice.device_id), choice.device_id)} · {labelFor(choice.channel)}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </fieldset>
  );
}
