import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, NetworkInterface, Provider } from '../api';
import type { ConnectionFinding, ConnectionSaved, HomeApi, Inventory, LocalDevice } from '../home-api';

const proposed = { created: 'Будет добавлено подключение', updated: 'Будет обновлено подключение', unchanged: 'Подключение уже настроено' };
const saved = { created: 'Подключение сохранено', updated: 'Подключение обновлено', unchanged: 'Подключение проверено: изменений нет' };
const fields = { ip: 'IP-адрес', version: 'Версия протокола', local_key: 'Локальный ключ' };
type Preview = { result: ConnectionFinding; expiresAt: number; requestedName: string };

// Cloud key availability alone does not establish a saved LAN connection.
function connectionConfigured(device: LocalDevice | undefined, devices: LocalDevice[]) {
  const direct = (row: LocalDevice | undefined) => Boolean(row?.transport === 'wifi' && row.ip && row.version && row.has_local_key);
  if (device?.transport !== 'zigbee') return direct(device);
  const parent = devices.find(row => row.id === device.parent_id);
  return Boolean(device.cid && parent?.is_gateway && direct(parent));
}

export function LocalConnectionsPage({ api, ready, sharingReady, developerReady, onAuthError, onConnections, onLock }: {
  api: HomeApi; ready: boolean; sharingReady: boolean; developerReady: boolean;
  onAuthError: () => void; onConnections: () => void; onLock: (locked: boolean) => void;
}) {
  const [provider, setProvider] = useState<Provider>(sharingReady ? 'sharing' : 'developer');
  const [devices, setDevices] = useState<CloudDevice[]>([]), [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [deviceId, setDeviceId] = useState(''), [address, setAddress] = useState('');
  const [query, setQuery] = useState(''), [showConfigured, setShowConfigured] = useState(false);
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [remaining, setRemaining] = useState(0), [operation, setOperation] = useState<'find' | 'save' | null>(null);
  const [error, setError] = useState(''), [success, setSuccess] = useState<ConnectionSaved | null>(null);
  const request = useRef<AbortController | null>(null), work = useRef<'find' | 'save' | null>(null);
  const mounted = useRef(true), callbacks = useRef({ onAuthError, onLock });
  callbacks.current = { onAuthError, onLock };
  const connected = ready && (provider === 'sharing' ? sharingReady : developerReady);

  function fail(failure: unknown) {
    setError(failure instanceof Error ? failure.message : 'Не удалось выполнить запрос.');
    if (failure instanceof ApiError && failure.status === 401) callbacks.current.onAuthError();
  }
  function reset() {
    request.current?.abort(); request.current = null;
    work.current = null; setOperation(null); setPreview(null); setConfirmed(false); setSuccess(null); setError('');
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); request.current = null; callbacks.current.onLock(false); };
  }, []);
  useEffect(() => {
    if (provider === 'sharing' && !sharingReady && developerReady) setProvider('developer');
    if (provider === 'developer' && !developerReady && sharingReady) setProvider('sharing');
  }, [provider, sharingReady, developerReady]);
  useEffect(() => {
    const controller = new AbortController();
    reset(); setDeviceId(''); setAddress(''); setQuery(''); setShowConfigured(false); setDevices([]); setInterfaces([]); setInventory(null);
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    void Promise.all([api.devices(provider, controller.signal), api.networkInterfaces(controller.signal), api.inventory(controller.signal)])
      .then(([rows, networks, home]) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(rows) || !Array.isArray(networks)) throw new Error('Не удалось прочитать список устройств и сетей.');
        setDevices(rows); setInterfaces(networks); setInventory(home);
      }).catch(failure => { if (!controller.signal.aborted) fail(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [api, connected, provider, revision]);
  useEffect(() => {
    if (!preview) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((preview.expiresAt - Date.now()) / 1000)));
    tick(); const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [preview]);

  async function find() {
    if (!connected || !deviceId || !address || work.current || loading) return;
    reset();
    const controller = new AbortController(); request.current = controller;
    work.current = 'find'; setOperation('find');
    const requestedName = devices.find(row => row.id === deviceId)?.name || deviceId;
    try {
      const result = await api.findLocalConnection(deviceId, provider, address, controller.signal);
      if (controller.signal.aborted) return;
      if (result.verified !== true || result.requested_device_id !== deviceId || result.interface_address !== address ||
          !result.finding_id || result.connection_device_id !== result.device.device_id ||
          !['direct', 'gateway'].includes(result.route) || (result.route === 'direct' && result.connection_device_id !== deviceId) ||
          !Object.hasOwn(proposed, result.action) || !Array.isArray(result.device.changed_fields) ||
          !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('Сервис вернул неожиданный результат. Повторите поиск.');
      const seconds = Math.min(result.expires_in, 300);
      setRemaining(seconds); setPreview({ result, expiresAt: Date.now() + seconds * 1000, requestedName });
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
    finally { if (request.current === controller) { request.current = null; work.current = null; setOperation(null); } }
  }
  async function save() {
    if (!preview || !confirmed || !connected || work.current || Date.now() >= preview.expiresAt) return;
    work.current = 'save'; setOperation('save'); callbacks.current.onLock(true); setError('');
    try {
      const result = await api.saveLocalConnection(preview.result.finding_id);
      if (mounted.current) {
        setSuccess(result); setDeviceId('');
        setInventory(current => current ? { ...current, devices: [...current.devices.filter(row => row.device_id !== result.device.device_id), result.device] } : current);
      }
    } catch (failure) {
      if (mounted.current) {
        fail(failure);
        if (!(failure instanceof ApiError)) setError('Ответ на сохранение не получен. Подключение могло сохраниться. Повторите поиск, чтобы проверить результат.');
      }
    } finally {
      work.current = null; callbacks.current.onLock(false);
      if (mounted.current) { setOperation(null); setPreview(null); setConfirmed(false); }
    }
  }

  const finding = preview?.result, detail = finding?.device;
  const room = inventory?.rooms.find(row => row.id === detail?.room_id);
  const building = inventory?.buildings.find(row => row.id === detail?.building_id);
  const saving = operation === 'save';
  const localDevices = inventory?.devices || [];
  const rows = devices.map(device => {
    const local = localDevices.find(row => row.device_id === device.id);
    return { device, local, configured: connectionConfigured(local, localDevices) };
  });
  const unconfigured = rows.filter(row => !row.configured).length;
  const search = query.trim().toLocaleLowerCase();
  const matching = rows.filter(({ device, local }) =>
    [device.name, ...(device.aliases || []), local?.name, ...(local?.aliases || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(search));
  const visible = matching.filter(row => showConfigured || !row.configured);
  function changeFilter() { reset(); setDeviceId(''); }
  return <section className="card local-connections-page" aria-labelledby="local-connections-heading">
    <p className="eyebrow">Домашняя сеть</p><h1 id="local-connections-heading">Локальные подключения</h1>
    <p className="muted">Выберите устройство из своего Tuya-аккаунта и сеть компьютера с сервисом. Найдём адрес и проверим ключ. Сохранение — отдельным действием после вашего подтверждения.</p>
    {!sharingReady && !developerReady && <div className="saved-summary">Сначала подключите Tuya-аккаунт. <button className="secondary" onClick={onConnections}>Открыть подключения</button></div>}
    <div className="local-connection-filter"><label>Поиск устройства<input type="search" placeholder="Название или алиас" value={query} disabled={!connected || loading || saving} onChange={event => { changeFilter(); setQuery(event.target.value); }} /></label><button className="secondary" aria-pressed={showConfigured} disabled={!connected || loading || saving} onClick={() => { changeFilter(); setShowConfigured(value => !value); }}>Показать настроенные</button>{connected && !loading && <span className="help">Нужно настроить: {unconfigured} · Настроено: {rows.length - unconfigured}</span>}</div>
    <div className="local-connection-form">
      <label>Аккаунт<select value={provider} disabled={!ready || saving || (!sharingReady && !developerReady)} onChange={event => { reset(); setProvider(event.target.value as Provider); }}><option value="sharing" disabled={!sharingReady}>Smart Life / QR</option><option value="developer" disabled={!developerReady}>Tuya Developer</option></select></label>
      <label>Устройство<select value={deviceId} disabled={!connected || loading || saving} onChange={event => { reset(); setDeviceId(event.target.value); }}><option value="">{loading ? 'Читаем устройства…' : 'Выберите устройство'}</option>{[false, true].map(configured => {
        const group = visible.filter(row => row.configured === configured);
        return group.length > 0 && <optgroup key={String(configured)} label={configured ? 'Настроено' : 'Нужно настроить'}>{group.map(({device: row}) => <option key={row.id} value={row.id}>{row.name}{row.aliases?.length ? ` · ${row.aliases.join(', ')}` : ''}{configured ? ' · Настроено' : ''}</option>)}</optgroup>;
      })}</select></label>
      <label>Сеть устройства<select value={address} disabled={!connected || loading || saving} onChange={event => { reset(); setAddress(event.target.value); }}><option value="">Выберите сеть</option>{interfaces.map(row => <option key={row.address} value={row.address}>{row.name} · {row.network} · IP {row.address}</option>)}</select></label>
    </div>
    {connected && !loading && devices.length > 0 && !visible.length && <p className="help">{search ? matching.length ? 'Есть совпадения среди настроенных устройств. Включите «Показать настроенные».' : 'По этому названию или алиасу устройств не найдено.' : 'Все устройства уже имеют локальное подключение. Включите «Показать настроенные», чтобы проверить их повторно.'}</p>}
    <div className="local-connection-actions"><button disabled={!connected || !deviceId || !address || loading || !!operation} onClick={() => void find()}>{operation === 'find' ? 'Ищем и проверяем…' : 'Найти и проверить'}</button>{operation === 'find' ? <button className="secondary" onClick={reset}>Отменить поиск</button> : <button className="secondary" disabled={!connected || loading || saving} onClick={() => { reset(); setRevision(value => value + 1); }}>Обновить списки</button>}</div>
    {operation === 'find' && <p role="status" className="help">Ожидаем объявление в выбранной сети и проверяем соединение. Обычно до 45 секунд. Настройки устройства и база не меняются.</p>}
    {connected && !loading && !error && (!devices.length || !interfaces.length) && <p className="help">{!devices.length ? 'В выбранном аккаунте нет устройств.' : 'Частные IPv4-сети не найдены. Подключите компьютер с сервисом к нужной сети и обновите списки.'}</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {finding && detail && preview && <section className="local-connection-preview" aria-labelledby="connection-preview-heading">
      <div className="local-connection-preview-title"><div><p className="eyebrow">Предварительный просмотр</p><h2 id="connection-preview-heading">{detail.name}</h2></div><span className="network-status online">✓ Соединение проверено</span></div>
      {detail.aliases.length > 0 && <p className="help">{detail.aliases.join(' · ')}</p>}
      <p><strong>{proposed[finding.action]}</strong></p>
      {finding.route === 'gateway' && <p className="saved-summary">Выбрано: {preview.requestedName}. Сохраняется подключение шлюза «{detail.name}». Проверка шлюза не подтверждает связь с самим дочерним устройством; его ключ и привязка не меняются.</p>}
      <dl className="local-connection-facts"><div><dt>Подключение</dt><dd>{detail.is_gateway ? 'Шлюз Tuya' : 'Устройство Wi-Fi'}</dd></div><div><dt>Сеть</dt><dd>{interfaces.find(row => row.address === finding.interface_address)?.network}</dd></div><div><dt>IP устройства</dt><dd>{detail.ip}</dd></div><div><dt>Протокол Tuya</dt><dd>{detail.version}</dd></div>{building && <div><dt>Здание</dt><dd>{building.name}</dd></div>}{room && <div><dt>Комната</dt><dd>{room.name}</dd></div>}<div><dt>Ключ</dt><dd>Проверен · {finding.key_source === 'device' ? 'из данных этого устройства' : 'из данных дочернего устройства шлюза'}</dd></div></dl>
      {finding.action === 'updated' && <p className="help">Будут изменены: {detail.changed_fields.map(key => fields[key]).join(', ')}. Имя, алиасы, комната и настроенные функции сохраняются.</p>}
      {finding.action === 'created' && <p className="help">Будет создано локальное подключение с показанными именем и размещением. Функции управления настраиваются отдельно.</p>}
      <p className="help" role="status">{remaining > 0 ? `Результат действует ещё ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}. Ключ остаётся на сервере.` : 'Срок результата истёк. Повторите поиск перед сохранением.'}</p>
      <label className="local-connection-confirm"><input type="checkbox" checked={confirmed} disabled={remaining <= 0 || saving} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю сохранение показанного подключения</label>
      <div className="local-connection-actions"><button disabled={!confirmed || remaining <= 0 || saving} onClick={() => void save()}>{saving ? 'Проверяем и сохраняем…' : 'Сохранить подключение'}</button><button className="secondary" disabled={saving} onClick={reset}>Отмена</button></div>
    </section>}
    {success && <div className="saved-summary" role="status"><strong>{saved[success.action]}: {success.device.name}.</strong><p className="help">Локальные параметры управления можно настроить в карточке устройства.</p></div>}
    <details className="network-explanation"><summary>Как работает поиск</summary><p>Список устройств и ключи берутся из выбранного авторизованного Tuya-аккаунта. По объявлению с точным идентификатором находим адрес в выбранной сети, затем проверяем ключ чтением состояния. Поиск ничего не сохраняет и не переключает устройство.</p><p>Для Zigbee подключение настраивается у его шлюза, если связь явно известна. Родитель не определяется по названию. Перед сохранением сервис заново проверяет соединение и актуальность результата. Предварительный просмотр действует пять минут; после перезапуска сервиса нужен новый поиск.</p></details>
  </section>;
}
