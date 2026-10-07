import { useState } from 'react';
import type { CloudDevice } from '../api';

export function DeviceList({ devices, loaded, ready, busy, onLoad, onControl }: {
  devices: CloudDevice[]; loaded: boolean; ready: boolean; busy: boolean; onLoad: () => void; onControl: (device: CloudDevice) => void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLocaleLowerCase();
  const filtered = devices.filter(device => [device.name, device.id, device.category || ''].join(' ').toLocaleLowerCase().includes(needle));
  return <section className="card devices" aria-labelledby="devices-heading">
    <div className="card-heading"><div><p className="eyebrow">Устройства аккаунта</p><h2 id="devices-heading">Ваш дом{loaded && <span className="count">{devices.length}</span>}</h2></div>
      <button className="secondary compact" disabled={!ready || busy} onClick={onLoad}>{loaded ? 'Обновить список' : 'Показать устройства'}</button></div>
    {loaded && devices.length > 0 && <label className="search">Поиск по названию или ID<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти устройство" /></label>}
    {filtered.length > 0 ? <ul className="device-grid">{filtered.map(device => <li key={device.id} className="device-card">
      <div className="device-heading"><span className="device-symbol" aria-hidden="true">◇</span><span className={'presence ' + (device.online ? 'online' : '')}>{device.online ? 'В сети' : 'Не в сети'}</span></div>
      <h3>{device.name || 'Без названия'}</h3><p className="device-id">{device.id}</p>
      <div className="device-meta"><span>{device.sub ? 'Через шлюз' : 'Прямое подключение'}</span><span className={device.has_local_key ? 'key-available' : 'muted'}>{device.has_local_key ? 'Ключ на сервере' : 'Ключ недоступен'}</span></div>
      <button className="secondary compact full-width" disabled={!ready || busy} onClick={() => onControl(device)}>Управлять</button>
    </li>)}</ul> : <div className="empty-state"><span aria-hidden="true">⌂</span><h3>{loaded ? (devices.length ? 'Ничего не найдено' : 'Устройств пока нет') : ready ? 'Устройства ещё не загружены' : 'Подключите Tuya-аккаунт'}</h3>
      <p>{loaded ? (devices.length ? 'Попробуйте другое название или ID.' : 'Добавьте устройства в Smart Life и обновите список.') : ready ? 'Нажмите «Показать устройства», чтобы загрузить их из подключённого аккаунта.' : 'После подключения здесь появится список ваших устройств.'}</p></div>}
  </section>;
}
