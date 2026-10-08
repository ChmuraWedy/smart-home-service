import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, Provider } from '../api';
import { displayReading, isStale, localSpec } from '../controls';
import { deviceRoutes, matchesDevice, mergeDevices, routeLabel } from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import { HomeApi } from '../home-api';
import type { DeviceState, Group, GroupState, Inventory } from '../home-api';
import { CloudControl } from './CloudControl';
import { GroupControl, LocalControl, groupSummary } from './LocalControls';
import { useClock } from './DeviceControls';
import { DeviceSurvey } from './DeviceSurvey';

type Selection = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice; route: DeviceRoute; parent?: Group } | { kind: 'survey'; device?: CloudDevice; provider?: Provider };
type Loaded = { api: HomeApi; mask: string; inventory: Inventory | null; cloud: Partial<Record<Provider, CloudDevice[]>>; errors: string[] };
const PAGE_SIZE = 24;
const NO_CLOUD: Partial<Record<Provider, CloudDevice[]>> = {};

function DeviceCard({ device, state, room, now, onOpen, onAdd }: {
  device: UnifiedDevice; state?: DeviceState; room: string; now: number; onOpen: (route: DeviceRoute) => void; onAdd?: (provider: Provider) => void;
}) {
  const routes = deviceRoutes(device);
  const [chosen, setChosen] = useState<DeviceRoute | null>(null);
  const route = chosen && routes.includes(chosen) ? chosen : routes[0];
  const cloud = route !== 'local' ? device.cloud[route] : undefined;
  const local = device.local;
  return <li className="device-card" aria-label={device.name}>
    <div className="device-heading"><span className="device-symbol" aria-hidden="true">◇</span>
      <span className={'presence ' + (cloud?.online || (route === 'local' && state?.available) ? 'online' : '')}>{cloud ? (cloud.online ? 'В сети' : 'Не в сети') : local && !local.enabled ? 'Отключено в настройках' : state?.available ? 'Доступно дома' : 'Состояние неизвестно'}</span>
    </div>
    <h3>{device.name}</h3><p className="help">{room} · {local ? (local.transport === 'zigbee' ? 'Через шлюз' : 'Wi-Fi') : cloud?.sub ? 'Через шлюз' : 'Прямое подключение'}</p>
    {local && <div className="card-readings"><p className="help">Последние показания в домашней сети</p>{Object.entries(local.capabilities).filter(([, cap]) => cap.readable).slice(0, 4).map(([key, cap]) => {
      const reading = state?.values[key];
      return <p key={key}><span>{localSpec(key, cap).label}</span><strong className={isStale(reading, now, true) || !state?.enabled ? 'unknown' : ''}>{displayReading(localSpec(key, cap), reading)}{reading?.known && (isStale(reading, now, true) || !state?.enabled) && ' · неактуально'}</strong></p>;
    })}</div>}
    {routes.length > 1 ? <label className="device-route">Способ управления<select aria-label={'Способ управления: ' + device.name} value={route} onChange={event => setChosen(event.target.value as DeviceRoute)}>{routes.map(value => <option key={value} value={value}>{routeLabel[value]}</option>)}</select></label> : <p className="help">{routeLabel[route]}</p>}
    <button className="secondary compact full-width" onClick={() => onOpen(route)}>Управлять</button>
    {!local && <button className="secondary compact full-width" disabled={!onAdd} onClick={() => route !== 'local' && onAdd?.(route)}>Добавить в дом</button>}
  </li>;
}

export function ControlCenter({ api, ready, sharingReady = false, developerReady = false, onAuthError, onLock, onConnections }: {
  api: HomeApi; ready: boolean; sharingReady?: boolean; developerReady?: boolean;
  onAuthError: () => void; onLock: (locked: boolean) => void; onConnections?: () => void;
}) {
  const mask = `${sharingReady}:${developerReady}`;
  const [record, setRecord] = useState<Loaded | null>(null);
  // Hide records and controls immediately when the server/account selection changes.
  const current = ready && record?.api === api && record.mask === mask ? record : null;
  const inventory = current?.inventory;
  const cloud = current?.cloud || NO_CLOUD;
  const [building, setBuilding] = useState(''), [room, setRoom] = useState(''), [search, setSearch] = useState('');
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ api: HomeApi; mask: string; value: Selection } | null>(null);
  const selected = ready && selection?.api === api && selection.mask === mask ? selection.value : null;
  const [states, setStates] = useState<Record<number, DeviceState>>({});
  const [groupStates, setGroupStates] = useState<Record<number, GroupState>>({});
  const now = useClock();
  useEffect(() => { onLock(Boolean(selected)); return () => onLock(false); }, [selected, onLock]);
  useEffect(() => {
    setSelection(null);
    if (!ready) return;
    const controller = new AbortController(); setBusy(true); setPage(0);
    setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, errors: [] } : { api, mask, inventory: null, cloud: {}, errors: [] });
    const handle = async (label: string, read: () => Promise<Inventory | CloudDevice[]>, provider?: Provider) => {
      try {
        const result = await read();
        if (controller.signal.aborted) return;
        if (provider && !Array.isArray(result)) throw new Error('Сервис вернул неожиданный список устройств.');
        setRecord(previous => previous?.api === api && previous.mask === mask ? {
          ...previous, ...(provider ? { cloud: { ...previous.cloud, [provider]: result as CloudDevice[] } } : { inventory: result as Inventory }),
        } : previous);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, errors: [...previous.errors, label + ': ' + (failure instanceof Error ? failure.message : 'Не удалось загрузить устройства.')] } : previous);
        if (failure instanceof ApiError && failure.status === 401) onAuthError();
      }
    };
    const requests = [handle('Домашняя сеть', () => api.inventory(controller.signal))];
    if (sharingReady) requests.push(handle('Smart Life', () => api.devices('sharing', controller.signal), 'sharing'));
    if (developerReady) requests.push(handle('Tuya Developer', () => api.devices('developer', controller.signal), 'developer'));
    void Promise.all(requests).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, ready, mask, revision]);
  const devices = useMemo(() => mergeDevices(inventory?.devices || [], cloud), [inventory, cloud]);
  const filteredRooms = inventory?.rooms.filter(item => !building || String(item.building_id) === building) || [];
  const entries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const filtered = devices.filter(device => (!building || String(device.local?.building_id) === building) && inRoom(device.local?.room_id ?? null) && matchesDevice(device, needle));
    const groups = inventory?.groups.filter(group => inRoom(group.room_id) && (!building || String(inventory.rooms.find(item => item.id === group.room_id)?.building_id) === building) && group.name.toLocaleLowerCase().includes(needle)) || [];
    return [...groups.map(group => ({ kind: 'group' as const, group })), ...filtered.map(device => ({ kind: 'device' as const, device }))];
  }, [devices, inventory, building, room, search]);
  const visible = useMemo(() => entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [entries, page]);
  useEffect(() => {
    const controller = new AbortController();
    setStates({}); setGroupStates({});
    // These endpoints read SQLite only. Browsing never polls LAN devices or
    // requests cloud function/status details for every account device.
    for (const entry of visible) {
      const local = entry.kind === 'device' ? entry.device.local : undefined;
      if (entry.kind === 'device' && !local) continue;
      const request = entry.kind === 'group' ? api.groupState(entry.group.id, controller.signal) : api.state(local!.id, false, controller.signal);
      void request.then(value => {
        if (controller.signal.aborted) return;
        if ('device_id' in value) setStates(current => ({ ...current, [value.device_id]: value }));
        else setGroupStates(current => ({ ...current, [value.group_id]: value }));
      }).catch(failure => { if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError(); });
    }
    return () => controller.abort();
  }, [api, visible]);
  function choose(value: Selection) { setSelection({ api, mask, value }); }
  function close() { setSelection(null); setRevision(value => value + 1); }
  if (selected?.kind === 'survey' && inventory) return <DeviceSurvey api={api} inventory={inventory} device={selected.device} provider={selected.provider} onClose={close} onAuthError={onAuthError} />;
  return <section className="card control-center" aria-labelledby="control-center-heading">
    <div className="card-heading"><div><p className="eyebrow">Ваш дом</p><h2 id="control-center-heading">Устройства и группы{current && <span className="count">{devices.length + (inventory?.groups.length || 0)}</span>}</h2></div><div className="survey-toolbar"><button className="secondary compact" disabled={!inventory || busy} onClick={() => choose({ kind: 'survey' })}>Добавить устройство</button><button className="secondary compact" disabled={!ready || busy} onClick={() => setRevision(value => value + 1)}>Обновить список</button></div></div>
    {!ready ? <p className="saved-summary">Сначала сохраните доступ к сервису в настройках подключения.</p> : <>
      <p className="help">Одна карточка для каждого устройства. Способ управления показывает, нужна ли связь с интернетом.</p>
      <div className="control-filters"><label>Здание<select value={building} onChange={event => { setBuilding(event.target.value); setRoom(''); setPage(0); }}><option value="">Все здания</option>{inventory?.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Комната<select value={room} onChange={event => { setRoom(event.target.value); setPage(0); }}><option value="">Все комнаты</option><option value="none">Без комнаты</option>{filteredRooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Поиск по названию, алиасу или ID<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Найти устройство или группу" /></label></div>
      {busy && <p role="status" className="help">Загружаем список…</p>}{current?.errors.map(error => <p key={error} role="alert" className="field-error">{error}</p>)}
      {!busy && current && !entries.length && <div className="empty-state"><h3>{devices.length || inventory?.groups.length ? 'Ничего не найдено' : 'Устройств пока нет'}</h3><p>{devices.length || inventory?.groups.length ? 'Измените фильтры или поисковый запрос.' : sharingReady || developerReady ? 'Добавьте устройства в Smart Life и обновите список.' : 'Подключите аккаунт Tuya, чтобы увидеть свои устройства.'}</p>{!devices.length && !sharingReady && !developerReady && onConnections && <button className="secondary compact" onClick={onConnections}>Настроить подключение</button>}</div>}
      <ul className="device-grid local-grid">{visible.map(entry => entry.kind === 'group' ? <li className="device-card group-card" key={'group-' + entry.group.id}>
        <p className="eyebrow">Группа · {entry.group.device_ids.length} устройств</p><h3>{entry.group.name}</h3><p className="reading">{groupStates[entry.group.id] ? groupSummary(groupStates[entry.group.id].members, now) : 'Состояние неизвестно'}</p><p className="help">В домашней сети</p><button className="secondary compact full-width" onClick={() => choose(entry)}>Открыть группу</button>
      </li> : <DeviceCard key={'device-' + entry.device.id} device={entry.device} state={entry.device.local ? states[entry.device.local.id] : undefined} room={inventory?.rooms.find(item => item.id === entry.device.local?.room_id)?.name || 'Без комнаты'} now={now} onOpen={route => choose({ ...entry, route })} onAdd={inventory ? provider => choose({ kind: 'survey', device: entry.device.cloud[provider], provider }) : undefined} />)}</ul>
      {entries.length > PAGE_SIZE && <div className="pagination"><button className="secondary compact" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Назад</button><span>{page + 1} / {Math.ceil(entries.length / PAGE_SIZE)}</span><button className="secondary compact" disabled={(page + 1) * PAGE_SIZE >= entries.length} onClick={() => setPage(value => value + 1)}>Далее</button></div>}
    </>}
    {selected?.kind === 'device' && selected.route === 'local' && selected.device.local && <LocalControl key={selected.device.local.id} api={api} device={selected.device.local} onAuthError={onAuthError} closeLabel={selected.parent ? 'Назад к группе' : undefined} onClose={() => selected.parent ? choose({ kind: 'group', group: selected.parent }) : close()} />}
    {selected?.kind === 'device' && selected.route !== 'local' && selected.device.cloud[selected.route] && <CloudControl key={selected.route + selected.device.id} api={api} device={{ ...selected.device.cloud[selected.route]!, name: selected.device.name }} devices={cloud[selected.route]} provider={selected.route} onClose={close} onAuthError={onAuthError} />}
    {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => choose({ kind: 'device', device: mergeDevices([device], cloud)[0], route: 'local', parent: selected.group })} />}
  </section>;
}
