import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api';
import { displayReading, isStale, localSpec } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceState, Group, GroupState, Inventory, LocalDevice } from '../home-api';
import { GroupControl, LocalControl, groupSummary } from './LocalControls';
import { useClock } from './DeviceControls';

type Selection = { kind: 'group'; group: Group } | { kind: 'device'; device: LocalDevice; parent?: Group };
const PAGE_SIZE = 24;
export function ControlCenter({ api, ready, onAuthError, onLock }: {
  api: HomeApi; ready: boolean; onAuthError: () => void; onLock: (locked: boolean) => void;
}) {
  const [inventoryRecord, setInventoryRecord] = useState<{ api: HomeApi; data: Inventory } | null>(null);
  const inventory = inventoryRecord?.api === api ? inventoryRecord.data : null;
  const [building, setBuilding] = useState(''), [room, setRoom] = useState(''), [search, setSearch] = useState('');
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [states, setStates] = useState<Record<number, DeviceState>>({});
  const [groupStates, setGroupStates] = useState<Record<number, GroupState>>({});
  const now = useClock();
  useEffect(() => { onLock(Boolean(selected)); return () => onLock(false); }, [selected, onLock]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(); setBusy(true); setError('');
    void api.inventory(controller.signal).then(data => {
      if (!controller.signal.aborted) { setInventoryRecord({ api, data }); setPage(0); }
    }).catch(failure => {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить устройства.'); if (failure instanceof ApiError && failure.status === 401) onAuthError(); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, ready, revision]);
  const filteredRooms = inventory?.rooms.filter(item => !building || String(item.building_id) === building) || [];
  const entries = useMemo(() => {
    if (!inventory) return [];
    const needle = search.trim().toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const devices = inventory.devices.filter(device => (!building || String(device.building_id) === building) && inRoom(device.room_id) &&
      [device.name, device.device_id, String(device.id), ...device.aliases].join(' ').toLocaleLowerCase().includes(needle));
    const groups = inventory.groups.filter(group => inRoom(group.room_id) && (!building || String(inventory.rooms.find(item => item.id === group.room_id)?.building_id) === building) && group.name.toLocaleLowerCase().includes(needle));
    return [...groups.map(group => ({ kind: 'group' as const, group })), ...devices.map(device => ({ kind: 'device' as const, device }))];
  }, [inventory, building, room, search]);
  const visible = useMemo(() => entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [entries, page]);
  useEffect(() => {
    const controller = new AbortController();
    setStates({}); setGroupStates({});
    // These endpoints read SQLite only. Opening a list never polls LAN devices.
    for (const entry of visible) {
      const request = entry.kind === 'device' ? api.state(entry.device.id, false, controller.signal) : api.groupState(entry.group.id, controller.signal);
      void request.then(value => {
        if (controller.signal.aborted) return;
        if ('device_id' in value) setStates(current => ({ ...current, [value.device_id]: value }));
        else setGroupStates(current => ({ ...current, [value.group_id]: value }));
      }).catch(failure => { if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError(); });
    }
    return () => controller.abort();
  }, [api, visible]);
  function close() { setSelected(null); setRevision(value => value + 1); }
  return <section className="card control-center" aria-labelledby="control-center-heading">
    <div className="card-heading"><div><p className="eyebrow">Устройства и группы</p><h2 id="control-center-heading">Локальное управление</h2></div><button className="secondary compact" disabled={!ready || busy} onClick={() => setRevision(value => value + 1)}>Обновить список</button></div>
    {!ready ? <p className="saved-summary">Сначала сохраните доступ к API в настройках подключения.</p> : <>
      <p className="help">Устройства из инвентаря сервиса. Показания берутся из кеша; опрос доступен на экране устройства или группы.</p>
      <div className="control-filters"><label>Здание<select value={building} onChange={event => { setBuilding(event.target.value); setRoom(''); setPage(0); }}><option value="">Все здания</option>{inventory?.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Комната<select value={room} onChange={event => { setRoom(event.target.value); setPage(0); }}><option value="">Все комнаты</option><option value="none">Без комнаты</option>{filteredRooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Поиск по названию, алиасу или ID<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Найти устройство или группу" /></label></div>
      {busy && <p role="status" className="help">Загружаем список…</p>}{error && <p role="alert" className="field-error">{error}</p>}
      {!busy && inventory && !entries.length && <div className="empty-state"><h3>{inventory.devices.length || inventory.groups.length ? 'Ничего не найдено' : 'Локальный инвентарь пуст'}</h3><p>{inventory.devices.length || inventory.groups.length ? 'Измените фильтры или поисковый запрос.' : 'Облачные устройства доступны на вкладке «Подключения». Для локального управления импортируйте устройства и настройте IP, parent/cid и capabilities через REST API.'}</p></div>}
      <ul className="device-grid local-grid">{visible.map(entry => entry.kind === 'group' ? <li className="device-card group-card" key={'group-' + entry.group.id}>
        <p className="eyebrow">Группа · {entry.group.device_ids.length} устройств</p><h3>{entry.group.name}</h3><p className="reading">{groupStates[entry.group.id] ? groupSummary(groupStates[entry.group.id].members, now) : 'Состояние неизвестно'}</p><button className="secondary compact full-width" onClick={() => setSelected(entry)}>Открыть группу</button>
      </li> : <li className="device-card" key={'device-' + entry.device.id}>
        <p className="eyebrow">{entry.device.transport === 'zigbee' ? 'Через шлюз' : 'Wi-Fi'}</p><h3>{entry.device.name}</h3><p className="help">{inventory?.rooms.find(item => item.id === entry.device.room_id)?.name || 'Без комнаты'}</p>
        <div className="card-readings">{Object.entries(entry.device.capabilities).filter(([, cap]) => cap.readable).slice(0, 4).map(([key, cap]) => {
          const reading = states[entry.device.id]?.values[key];
          return <p key={key}><span>{localSpec(key, cap).label}</span><strong className={isStale(reading, now, true) || !states[entry.device.id]?.enabled ? 'unknown' : ''}>{displayReading(localSpec(key, cap), reading)}{reading?.known && (isStale(reading, now, true) || !states[entry.device.id]?.enabled) && ' · неактуально'}</strong></p>;
        })}</div><button className="secondary compact full-width" onClick={() => setSelected(entry)}>Управлять</button>
      </li>)}</ul>
      {entries.length > PAGE_SIZE && <div className="pagination"><button className="secondary compact" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Назад</button><span>{page + 1} / {Math.ceil(entries.length / PAGE_SIZE)}</span><button className="secondary compact" disabled={(page + 1) * PAGE_SIZE >= entries.length} onClick={() => setPage(value => value + 1)}>Далее</button></div>}
    </>}
    {selected?.kind === 'device' && <LocalControl key={selected.device.id} api={api} device={selected.device} onAuthError={onAuthError} closeLabel={selected.parent ? 'Назад к группе' : undefined} onClose={() => selected.parent ? setSelected({ kind: 'group', group: selected.parent }) : close()} />}
    {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => setSelected({ kind: 'device', device, parent: selected.group })} />}
  </section>;
}
