import { MSG, t } from "../i18n";
import type { CloudDevice } from '../api';
import type { DeviceRoute } from '../devices';
import { useCallback, useState } from 'react';
import { displayReading, isStale, localSpec, validateControlValue } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceState, Group, GroupState, LocalDevice } from '../home-api';
import { readLocalDevice } from '../local-device-cache';
import { useAppDispatch, useAppSelector } from '../store';
import { cacheDeviceMetadata, localMetadataKey, nextDeviceMetadataRevision } from '../device-metadata';
import { localPendingScope } from '../pending-device-values';
import { useLocalDeviceState } from '../use-local-device-state';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import DeviceInformation from './DeviceInformation';
import { useAutomaticControls } from '../control-drafts';
import { DeviceAliases } from './DeviceAliases';
import { BatteryBadge, batteryFromSpecs, isBattery } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';

export function LocalControl({
  api, device, gateway, cloudDevice, routes, onClose, onAuthError, closeLabel, room, onSetup,
}: {
  api: HomeApi; device: LocalDevice; gateway?: LocalDevice; cloudDevice?: CloudDevice; routes?: DeviceRoute[];
  onClose: () => void; onAuthError: () => void; closeLabel?: string; room?: string; onSetup?: () => void;
}) {
  const [aliasBusy, setAliasBusy] = useState(false);
  const dispatch = useAppDispatch();
  const metadataKey = localMetadataKey(api, device.id);
  const savedName = useAppSelector(state => state.deviceMetadata.devices[metadataKey]?.name?.value);
  const cached = useLocalDeviceState(api, device.id);
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const revision = nextDeviceMetadataRevision();
    const [metadata, state] = await Promise.all([
      api.device(device.id, signal),
      dispatch(readLocalDevice(api, device.id, refresh, signal, document.visibilityState !== 'hidden')),
    ]);
    if (metadata.id !== device.id) throw new Error(t(MSG.THE_SERVICE_RETURNED_A_DIFFERENT_DEVICE));
    if (!signal?.aborted) dispatch(cacheDeviceMetadata([{
      key: metadataKey, revision, name: metadata.name, aliases: metadata.aliases,
    }]));
    return { metadata, state };
  }, [api, device.id, dispatch, metadataKey]);
  const poll = useCallback(async (current: {metadata: LocalDevice; state: DeviceState}, signal: AbortSignal) => {
    const state = await dispatch(readLocalDevice(api, device.id, false, signal, true));
    return {...current, state};
  }, [api, device.id, dispatch]);
  const session = useControlSession(load, onAuthError, poll), now = useClock();
  const state = cached ?? session.data?.state;
  const item = session.data?.metadata || device;
  const name = savedName ?? item.name;
  const pendingScope = localPendingScope(api, item.id);
  const drafts = useAutomaticControls(changes => session.execute(async () => {
    for (const change of changes) validateControlValue(change.spec, change.value!);
    const result = await api.setCapabilities(item.id, Object.fromEntries(changes.map(change => [change.spec.key, change.value!])));
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
    return {text:t(MSG.COMMAND_ACCEPTED_NOTICE)};
  }), !session.busy && !aliasBusy && session.readOK && !!state?.enabled);
  const specs = Object.entries(item.capabilities).map(([key,cap]) => localSpec(key,cap));
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  return (
    <ControlDialog onRefresh={session.refresh}
      information={<DeviceConnectionDescription room={room} route="local" localTransport={item.transport} />}
      statusContent={<BatteryBadge reading={state ? batteryFromSpecs(specs,Object.fromEntries(Object.entries(state.values).filter(([,reading]) => reading.known).map(([key,reading]) => [key,reading.value]))) : undefined} />} className={Object.values(item.capabilities).some(spec => spec.encoding?.startsWith('tuya_')) ? 'bulb-controls' : ''} title={name} busy={session.busy || aliasBusy} onClose={onClose} closeLabel={closeLabel}
      titleContent={<DeviceAliases api={api} deviceId={item.device_id} name={name} initialAliases={item.aliases} localId={item.id} disabled={session.busy} onBusy={setAliasBusy} onAuthError={onAuthError} />}
      connectionContent={<DeviceConnectionSummary room={room} route="local" localTransport={item.transport} status={!state ? t(MSG.CHECKING_CONNECTION) : !state.enabled ? t(MSG.DISABLED_IN_SETTINGS) : state.available ? t(MSG.AVAILABLE_LOCALLY) : t(MSG.STATUS_UNKNOWN)} online={state?.enabled && state?.available} />}
    >
      {state && !state.enabled && <p className="saved-summary">{t(MSG.THIS_DEVICE_OR_ITS_GATEWAY_IS_DISABLED_IN)}</p>}
      {primaryActivity && <DeviceActivity api={api} deviceId={String(item.id)} provider="local" specs={specs} primary onAuthError={onAuthError} />}
      <div className={"capability-grid" + (specs.every(spec => !spec.writable) ? " sensor-grid" : "")}>
        {session.data && state && Object.entries(item.capabilities).filter(([key]) => !isBattery(key)).map(([key, cap]) => (
          <CapabilityField pendingScope={pendingScope} key={key} spec={localSpec(key, cap)} stage={cap.type === 'boolean' ? undefined : drafts.stage} immediatePower reading={state.values[key]} now={now} local={true} disabled={session.busy || !session.readOK || !state.enabled} onSend={value => session.execute(async () => {
      const result = await api.setCapability(item.id, key, value);
      if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
      return { text: t(MSG.COMMAND_ACCEPTED_NOTICE) };
    })}
          />
))}
      </div>
      {session.data && !Object.keys(item.capabilities).length && (
      <div className="saved-summary">
        {item.is_gateway ? <p>{t(MSG.THE_GATEWAY_IS_CONFIGURED_FOR_LOCAL_CHILD_DEVICE)}</p> : (
          <>
            <p>{t(MSG.MAP_LOCAL_PARAMETERS_AFTER_SAVING)}</p>
            {onSetup && <button disabled={session.busy || aliasBusy || !item.enabled} onClick={onSetup}>{t(MSG.SET_UP_FUNCTIONS)}</button>}
          </>
    )}
      </div>
)}
      {!primaryActivity && <DeviceActivity api={api} deviceId={String(item.id)} provider="local" specs={specs} onAuthError={onAuthError} />}
      <DeviceInformation
        api={api}
        deviceId={item.device_id}
        displayName={name}
        route="local"
        routes={routes ?? ['local']}
        local={item}
        cloud={cloudDevice}
        gateway={gateway}
        onAuthError={onAuthError}
      />
      <ControlFeedback busy={session.busy} notice={session.notice} />
    </ControlDialog>
  );
}

export function groupSummary(members: DeviceState[], now: number): string {
  const values = members.map(member => {
    const reading = member.values.switch;
    return member.enabled && !isStale(reading, now, true) && typeof reading?.value === 'boolean' ? reading.value : null;
  });
  if (!values.length || values.includes(null)) return t(MSG.STATUS_UNKNOWN);
  return values.every(value => value === true) ? t(MSG.ALL_ON) : values.every(value => value === false) ? t(MSG.ALL_OFF) : t(MSG.SOME_ON);
}

export function GroupControl({ api, group, onClose, onDevice, onAuthError }: {
  api: HomeApi; group: Group; onClose: () => void; onDevice: (device: LocalDevice) => void; onAuthError: () => void;
}) {
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const previous = await api.groupState(group.id, signal), warnings: string[] = [];
    if (previous.group_id !== group.id) throw new Error(t(MSG.THE_SERVICE_RETURNED_A_DIFFERENT_GROUP));
    const devices = await Promise.all(previous.members.map(member => api.device(member.device_id, signal)));
    if (refresh) for (const device of devices) {
      try { await api.state(device.id, true, signal); }
      catch (error) { if (signal?.aborted) throw error; warnings.push(device.name); }
    }
    const state = refresh ? await api.groupState(group.id, signal) : previous;
    return { devices, state, warnings };
  }, [api, group.id]);
  const session = useControlSession<{ devices: LocalDevice[]; state: GroupState; warnings: string[] }>(load, onAuthError), now = useClock();
  const disabled = session.busy || !session.readOK || !session.data?.state.members.length || session.data.state.members.some(member => !member.enabled);
  const send = (command: 'on' | 'off') => session.execute(async () => {
    const result = await api.groupCommand(group.id, command);
    const accepted = result.results.filter(member => member.acknowledged).length;
    const failed = result.results.filter(member => !member.acknowledged).map(member => session.data?.devices.find(device => device.id === member.device_id)?.name || t(MSG.DEVICE_PREFIX) + member.device_id);
    return { text: t(MSG.COMMAND_ACCEPTED_BY_OF_DEVICES, [accepted, result.results.length]) + (failed.length ? t(MSG.NOT_CONFIRMED) + failed.join(', ') + '.' : ''), error: !result.all_acknowledged };
  });
  return (
    <ControlDialog onRefresh={session.refresh} title={group.name} subtitle={t(MSG.GROUP_LOCAL_CONTROL)} busy={session.busy} onClose={onClose}>
      <div className="control-toolbar">
        <strong>{session.data ? groupSummary(session.data.state.members, now) : t(MSG.LOADING_STATUS)}</strong>
      </div>
      <div className="power-actions group-power">
        <button disabled={disabled} onClick={() => void send('on')}>{t(MSG.TURN_GROUP_ON)}</button>
        <button className="secondary" disabled={disabled} onClick={() => void send('off')}>{t(MSG.TURN_GROUP_OFF)}</button>
      </div>
      <p className="help">{t(MSG.COMMANDS_ARE_SENT_TO_MEMBERS_IN_SEQUENCE)}</p>
      {!!session.data?.warnings.length && <p className="field-error" role="alert">{t(MSG.STATUS_UNAVAILABLE) + " "}{session.data.warnings.join(', ')}{t(MSG.SHOWING_THE_LAST_KNOWN_DATA)}</p>}
      <ul className="group-members">{session.data?.devices.map(device => {
      const state = session.data!.state.members.find(member => member.device_id === device.id);
      const reading = state?.values.switch;
      return (
        <li key={device.id}>
          <div>
            <h3>{device.name}</h3>
            <p className="help">{state?.enabled && !isStale(reading, now, true) ? displayReading(localSpec('switch', device.capabilities.switch), reading) : t(MSG.STATUS_UNKNOWN)}</p>
          </div>
          <button className="secondary compact" disabled={session.busy} onClick={() => onDevice(device)}>{t(MSG.CONTROL_DEVICE)}</button>
        </li>
      );
    })}
      </ul>
      <ControlFeedback busy={session.busy} notice={session.notice} />
    </ControlDialog>
  );
}
