import { useCallback } from 'react';
import { displayReading, isStale, localSpec } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceState, Group, GroupState, LocalDevice } from '../home-api';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceNetwork } from './DeviceNetwork';

export function LocalControl({ api, device, onClose, onAuthError, closeLabel }: {
  api: HomeApi; device: LocalDevice; onClose: () => void; onAuthError: () => void; closeLabel?: string;
}) {
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const [metadata, state] = await Promise.all([api.device(device.id, signal), api.state(device.id, refresh, signal)]);
    if (metadata.id !== device.id || state.device_id !== device.id) throw new Error('Сервис вернул другое устройство.');
    return { metadata, state };
  }, [api, device.id]);
  const session = useControlSession(load, onAuthError), now = useClock();
  const item = session.data?.metadata || device;
  return <ControlDialog title={item.name} subtitle={item.transport === 'zigbee' ? 'Локально · через шлюз' : 'Локально · Wi-Fi'} busy={session.busy} onClose={onClose} closeLabel={closeLabel}>
    <div className="control-toolbar"><span className="help">{item.transport === 'zigbee' ? 'Команды передаются через настроенный шлюз.' : 'Прямое подключение к устройству.'}</span><button className="secondary compact" disabled={session.busy} onClick={() => void session.refresh()}>Обновить статус</button></div>
    <p className="help">Первое открытие читает кеш. «Обновить статус» опрашивает устройство. Команды и ключи Tuya обрабатывает сервер.</p>
    {session.data && !session.data.state.enabled && <p className="saved-summary">Устройство или его шлюз отключены в настройках сервиса.</p>}
    <div className="capability-grid">{session.data && Object.entries(item.capabilities).map(([key, cap]) => <CapabilityField key={key} spec={localSpec(key, cap)} reading={session.data!.state.values[key]} now={now} local={true} disabled={session.busy || !session.readOK || !session.data!.state.enabled} onSend={value => session.execute(async () => {
      const result = await api.setCapability(item.id, key, value);
      if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
      return { text: 'Команда принята.' };
    })} />)}</div>
    {session.data && !Object.keys(item.capabilities).length && <p className="saved-summary">Возможности ещё не настроены. Задайте проверенные capabilities устройству или его типу через REST API.</p>}
    <DeviceNetwork api={api} deviceId={item.device_id} provider="local" onAuthError={onAuthError} />
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}

export function groupSummary(members: DeviceState[], now: number): string {
  const values = members.map(member => {
    const reading = member.values.switch;
    return member.enabled && !isStale(reading, now, true) && typeof reading?.value === 'boolean' ? reading.value : null;
  });
  if (!values.length || values.includes(null)) return 'Состояние неизвестно';
  return values.every(value => value === true) ? 'Все включены' : values.every(value => value === false) ? 'Все выключены' : 'Часть включена';
}

export function GroupControl({ api, group, onClose, onDevice, onAuthError }: {
  api: HomeApi; group: Group; onClose: () => void; onDevice: (device: LocalDevice) => void; onAuthError: () => void;
}) {
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    const previous = await api.groupState(group.id, signal), warnings: string[] = [];
    if (previous.group_id !== group.id) throw new Error('Сервис вернул другую группу.');
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
    const failed = result.results.filter(member => !member.acknowledged).map(member => session.data?.devices.find(device => device.id === member.device_id)?.name || 'Устройство ' + member.device_id);
    return { text: `Команда принята ${accepted} из ${result.results.length} устройств.` + (failed.length ? ' Не подтверждено: ' + failed.join(', ') + '.' : ''), error: !result.all_acknowledged };
  });
  return <ControlDialog title={group.name} subtitle="Группа · локальное управление" busy={session.busy} onClose={onClose}>
    <div className="control-toolbar"><strong>{session.data ? groupSummary(session.data.state.members, now) : 'Загружаем состояние'}</strong><button className="secondary compact" disabled={session.busy} onClick={() => void session.refresh()}>Обновить статус</button></div>
    <div className="power-actions group-power"><button disabled={disabled} onClick={() => void send('on')}>Включить группу</button><button className="secondary" disabled={disabled} onClick={() => void send('off')}>Выключить группу</button></div>
    <p className="help">Команда отправляется участникам последовательно. Частичные ошибки показаны отдельно; подтверждение команды не заменяет показание состояния.</p>
    {!!session.data?.warnings.length && <p className="field-error" role="alert">Статус не получен: {session.data.warnings.join(', ')}. Показаны последние известные данные.</p>}
    <ul className="group-members">{session.data?.devices.map(device => {
      const state = session.data!.state.members.find(member => member.device_id === device.id);
      const reading = state?.values.switch;
      return <li key={device.id}><div><h3>{device.name}</h3><p className="help">{state?.enabled && !isStale(reading, now, true) ? displayReading(localSpec('switch', device.capabilities.switch), reading) : 'Состояние неизвестно'}</p></div><button className="secondary compact" disabled={session.busy} onClick={() => onDevice(device)}>Управлять устройством</button></li>;
    })}</ul>
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
