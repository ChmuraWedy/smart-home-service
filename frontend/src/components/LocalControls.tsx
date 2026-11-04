import { t } from "../i18n";
import { useCallback, useState } from 'react';
import { displayReading, isStale, localSpec, validateControlValue } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceState, Group, GroupState, LocalDevice } from '../home-api';
import { CapabilityField, ControlApply, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceNetwork } from './DeviceNetwork';
import { useControlDrafts } from '../control-drafts';
import { DeviceAliases } from './DeviceAliases';
import { BatteryBadge, batteryFromSpecs, isBattery } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';

export function LocalControl({ api, device, onClose, onAuthError, closeLabel, room, onSetup }: {
  api: HomeApi; device: LocalDevice; onClose: () => void; onAuthError: () => void; closeLabel?: string; room?: string; onSetup?: () => void;
}) {
  const [aliasBusy, setAliasBusy] = useState(false);
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const [metadata, state] = await Promise.all([api.device(device.id, signal), api.state(device.id, refresh, signal)]);
    if (metadata.id !== device.id || state.device_id !== device.id) throw new Error(t("Сервис вернул другое устройство."));
    return { metadata, state };
  }, [api, device.id]);
  const session = useControlSession(load, onAuthError), now = useClock();
  const item = session.data?.metadata || device;
  const drafts = useControlDrafts();
  const specs = Object.entries(item.capabilities).map(([key,cap]) => localSpec(key,cap));
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  return <ControlDialog onRefresh={session.refresh} information={<DeviceConnectionDescription room={room} route="local" localTransport={item.transport} />} statusContent={<BatteryBadge reading={session.data ? batteryFromSpecs(specs,Object.fromEntries(Object.entries(session.data.state.values).filter(([,reading]) => reading.known).map(([key,reading]) => [key,reading.value]))) : undefined} />} className={Object.values(item.capabilities).some(spec => spec.encoding?.startsWith('tuya_')) ? 'bulb-controls' : ''} title={item.name} busy={session.busy || aliasBusy} onClose={onClose} closeLabel={closeLabel} titleContent={<DeviceAliases api={api} deviceId={item.device_id} name={item.name} initialAliases={item.aliases} localId={item.id} disabled={session.busy} onBusy={setAliasBusy} onAuthError={onAuthError} />} connectionContent={<DeviceConnectionSummary room={room} route="local" localTransport={item.transport} status={!session.data ? t("Проверяем связь") : !session.data.state.enabled ? t("Отключено в настройках") : session.data.state.available ? t("Доступно дома") : t("Состояние неизвестно")} online={session.data?.state.enabled && session.data?.state.available} />}>
    <div className="control-toolbar"><span className="help">{item.is_gateway ? t("Локальное подключение к шлюзу.") : item.transport === 'zigbee' ? t("Команды передаются через настроенный шлюз.") : t("Прямое подключение к устройству.")}</span><div className="control-actions">
      {Object.values(item.capabilities).some(cap => cap.writable) && <ControlApply count={drafts.count} invalid={drafts.invalid} disabled={session.busy || aliasBusy || !session.readOK || !session.data?.state.enabled} onApply={() => void drafts.apply(changes => session.execute(async () => {
        for (const change of changes) validateControlValue(change.spec, change.value!);
        const result = await api.setCapabilities(item.id, Object.fromEntries(changes.map(change => [change.spec.key, change.value!])));
        if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
        return {text:t("Команда принята.")};
      }))} />}
    </div></div>
    <p className="help">{t("Первое открытие читает кеш. «Обновить статус» опрашивает устройство. Команды и ключи Tuya обрабатывает сервер.")}</p>
    {session.data && !session.data.state.enabled && <p className="saved-summary">{t("Устройство или его шлюз отключены в настройках сервиса.")}</p>}
    {primaryActivity && <DeviceActivity api={api} deviceId={String(item.id)} provider="local" specs={specs} primary onAuthError={onAuthError} />}
    <div className={"capability-grid" + (specs.every(spec => !spec.writable) ? " sensor-grid" : "")}>{session.data && Object.entries(item.capabilities).filter(([key]) => !isBattery(key)).map(([key, cap]) => <CapabilityField key={key} spec={localSpec(key, cap)} stage={drafts.stage} reading={session.data!.state.values[key]} now={now} local={true} onRefresh={session.refresh} disabled={session.busy || !session.readOK || !session.data!.state.enabled} onSend={value => session.execute(async () => {
      const result = await api.setCapability(item.id, key, value);
      if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
      return { text: t("Команда принята.") };
    })} />)}</div>
    {session.data && !Object.keys(item.capabilities).length && <div className="saved-summary">{item.is_gateway ? <p>{t("Шлюз настроен для локального подключения дочерних устройств. Их показания и управление находятся в карточках самих устройств.")}</p> : <><p>{t("Подключение сохранено. Чтобы появились переключатели и показания, сопоставьте локальные параметры устройства с функциями Tuya.")}</p>{onSetup && <button disabled={session.busy || aliasBusy || !item.enabled} onClick={onSetup}>{t("Настроить функции")}</button>}</>}</div>}
    {!primaryActivity && <DeviceActivity api={api} deviceId={String(item.id)} provider="local" specs={specs} onAuthError={onAuthError} />}
    <DeviceNetwork api={api} deviceId={item.device_id} provider="local" onAuthError={onAuthError} />
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}

export function groupSummary(members: DeviceState[], now: number): string {
  const values = members.map(member => {
    const reading = member.values.switch;
    return member.enabled && !isStale(reading, now, true) && typeof reading?.value === 'boolean' ? reading.value : null;
  });
  if (!values.length || values.includes(null)) return t("Состояние неизвестно");
  return values.every(value => value === true) ? t("Все включены") : values.every(value => value === false) ? t("Все выключены") : t("Часть включена");
}

export function GroupControl({ api, group, onClose, onDevice, onAuthError }: {
  api: HomeApi; group: Group; onClose: () => void; onDevice: (device: LocalDevice) => void; onAuthError: () => void;
}) {
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const previous = await api.groupState(group.id, signal), warnings: string[] = [];
    if (previous.group_id !== group.id) throw new Error(t("Сервис вернул другую группу."));
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
    const failed = result.results.filter(member => !member.acknowledged).map(member => session.data?.devices.find(device => device.id === member.device_id)?.name || t("Устройство ") + member.device_id);
    return { text: t("Команда принята {0} из {1} устройств.", [accepted, result.results.length]) + (failed.length ? t(" Не подтверждено: ") + failed.join(', ') + '.' : ''), error: !result.all_acknowledged };
  });
  return <ControlDialog onRefresh={session.refresh} title={group.name} subtitle={t("Группа · локальное управление")} busy={session.busy} onClose={onClose}>
    <div className="control-toolbar"><strong>{session.data ? groupSummary(session.data.state.members, now) : t("Загружаем состояние")}</strong></div>
    <div className="power-actions group-power"><button disabled={disabled} onClick={() => void send('on')}>{t("Включить группу")}</button><button className="secondary" disabled={disabled} onClick={() => void send('off')}>{t("Выключить группу")}</button></div>
    <p className="help">{t("Команда отправляется участникам последовательно. Частичные ошибки показаны отдельно; подтверждение команды не заменяет показание состояния.")}</p>
    {!!session.data?.warnings.length && <p className="field-error" role="alert">{t("Статус не получен:") + " "}{session.data.warnings.join(', ')}{t(". Показаны последние известные данные.")}</p>}
    <ul className="group-members">{session.data?.devices.map(device => {
      const state = session.data!.state.members.find(member => member.device_id === device.id);
      const reading = state?.values.switch;
      return <li key={device.id}><div><h3>{device.name}</h3><p className="help">{state?.enabled && !isStale(reading, now, true) ? displayReading(localSpec('switch', device.capabilities.switch), reading) : t("Состояние неизвестно")}</p></div><button className="secondary compact" disabled={session.busy} onClick={() => onDevice(device)}>{t("Управлять устройством")}</button></li>;
    })}</ul>
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
