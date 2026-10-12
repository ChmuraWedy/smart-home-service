import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, LanDevice, NetworkInterface, NetworkScan, Provider } from '../api';
import type { ConnectionFinding, HomeApi, Inventory, LocalDevice } from '../home-api';

type Stage = 'start' | 'search' | 'choose' | 'verify' | 'confirm' | 'save' | 'done';
type Candidate = { device: CloudDevice; observed: LanDevice[]; configured: boolean };
type Checked = { candidate: Candidate; finding?: ConnectionFinding; expiresAt?: number; error?: string };
type Outcome = { id: string; name: string; message: string; saved: boolean };
const actions = { created: 'Будет добавлено', updated: 'Будет обновлено', unchanged: 'Изменений нет' };
const savedActions = { created: 'Подключение сохранено', updated: 'Подключение обновлено', unchanged: 'Проверено: изменений нет' };
const changes = { ip: 'IP-адрес', version: 'версия протокола', local_key: 'локальный ключ' };
const SEARCH_SECONDS = 15;
const MAX_SELECTION = 16;

function configured(device: LocalDevice | undefined, devices: LocalDevice[]) {
  const direct = (row: LocalDevice | undefined) => Boolean(row?.transport === 'wifi' && row.ip && row.version && row.has_local_key);
  if (device?.transport !== 'zigbee') return direct(device);
  const parent = devices.find(row => row.id === device.parent_id);
  return Boolean(device.cid && parent?.is_gateway && direct(parent));
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : 'Не удалось выполнить запрос.';

export function LocalConnectionsPage({ api, ready, sharingReady, developerReady, onAuthError, onConnections, onLock }: {
  api: HomeApi; ready: boolean; sharingReady: boolean; developerReady: boolean;
  onAuthError: () => void; onConnections: () => void; onLock: (locked: boolean) => void;
}) {
  const [provider, setProvider] = useState<Provider>(sharingReady ? 'sharing' : 'developer');
  const [devices, setDevices] = useState<CloudDevice[]>([]), [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [address, setAddress] = useState(''), [includeConfigured, setIncludeConfigured] = useState(false);
  const [stage, setStage] = useState<Stage>('start'), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [checked, setChecked] = useState<Checked[]>([]), [confirmed, setConfirmed] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]), [query, setQuery] = useState('');
  const [error, setError] = useState(''), [progress, setProgress] = useState(''), [seconds, setSeconds] = useState(SEARCH_SECONDS);
  const [now, setNow] = useState(Date.now()), [unknown, setUnknown] = useState(0), [excluded, setExcluded] = useState(0);
  const request = useRef<AbortController | null>(null), scan = useRef<string | null>(null), busy = useRef(false), mounted = useRef(true);
  const callbacks = useRef({ onAuthError, onLock });
  callbacks.current = { onAuthError, onLock };
  const connected = ready && (provider === 'sharing' ? sharingReady : developerReady);
  const working = stage === 'search' || stage === 'verify' || stage === 'save';
  const local = inventory?.devices || [];
  const pending = devices.filter(device => !configured(local.find(row => row.device_id === device.id), local));
  const valid = checked.filter(row => row.finding && row.expiresAt! > now);
  const expired = checked.some(row => row.finding && row.expiresAt! <= now);

  function fail(failure: unknown) {
    setError(message(failure));
    if (failure instanceof ApiError && failure.status === 401) callbacks.current.onAuthError();
  }
  function stop() {
    request.current?.abort(); request.current = null; busy.current = false;
    if (scan.current) { const id = scan.current; scan.current = null; void api.stopNetworkScan(id).catch(() => {}); }
  }
  function startOver() {
    stop(); setStage('start'); setCandidates([]); setSelected([]); setChecked([]); setConfirmed(false);
    setOutcomes([]); setQuery(''); setError(''); setProgress('');
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); callbacks.current.onLock(false); };
  }, [api]);
  useEffect(() => {
    if (!sharingReady && developerReady) setProvider('developer');
    else if (!developerReady && sharingReady) setProvider('sharing');
  }, [sharingReady, developerReady]);
  useEffect(() => {
    const controller = new AbortController();
    startOver(); setDevices([]); setInterfaces([]); setInventory(null); setAddress(''); setIncludeConfigured(false);
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    void Promise.all([api.devices(provider, controller.signal), api.networkInterfaces(controller.signal), api.inventory(controller.signal)])
      .then(([rows, networks, home]) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(rows) || !Array.isArray(networks)) throw new Error('Не удалось прочитать устройства и сети.');
        setDevices(rows); setInterfaces(networks); setInventory(home);
      }).catch(failure => { if (!controller.signal.aborted) fail(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); stop(); };
  }, [api, connected, provider, revision]);
  useEffect(() => {
    if (stage !== 'confirm') return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  useEffect(() => {
    if (stage !== 'search' && stage !== 'verify') return;
    const hidden = () => {
      if (!document.hidden) return;
      stop(); setChecked([]); setConfirmed(false); setStage(stage === 'search' ? 'start' : 'choose');
      setError('Поиск остановлен: вкладка скрыта. Запустите его снова, когда будете готовы.');
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [stage, api]);

  async function search() {
    if (!connected || !address || loading || busy.current) return;
    startOver(); busy.current = true; setStage('search'); setSeconds(SEARCH_SECONDS);
    const controller = new AbortController(); request.current = controller;
    let id: string | undefined;
    try {
      let snapshot = await api.startNetworkScan(address, controller.signal); id = snapshot.scan_id; scan.current = id;
      const validate = (row: NetworkScan) => {
        if (row.scan_id !== id || row.interface?.address !== address || !Array.isArray(row.devices)) throw new Error('Наблюдение относится к другой сети. Повторите поиск.');
      };
      validate(snapshot);
      const readyBy = Date.now() + 2000;
      while (!snapshot.ports.includes(7000) && Date.now() < readyBy) {
        await pause(250, controller.signal); snapshot = await api.networkScan(id, controller.signal); validate(snapshot);
      }
      if (!snapshot.ports.includes(7000)) throw new Error('Приём объявлений Tuya недоступен. Проверьте доступность порта 7000.');
      snapshot = await api.requestNetworkAnnouncements(id, controller.signal); validate(snapshot);
      const deadline = Date.now() + SEARCH_SECONDS * 1000;
      while (Date.now() < deadline) {
        setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        await pause(Math.min(1000, deadline - Date.now()), controller.signal);
        snapshot = await api.networkScan(id, controller.signal); validate(snapshot);
      }
      if (controller.signal.aborted) return;
      const detected: Candidate[] = [];
      let skipped = 0;
      for (const device of devices) {
        const observed = snapshot.devices.filter(row => row.device_id === device.id);
        if (!observed.length) continue;
        const isConfigured = configured(local.find(row => row.device_id === device.id), local);
        if (!includeConfigured && isConfigured) { skipped++; continue; }
        detected.push({ device, observed, configured: isConfigured });
      }
      setCandidates(detected); setExcluded(skipped);
      setUnknown(snapshot.devices.filter(row => row.device_id && !devices.some(device => device.id === row.device_id)).length);
      setSelected([]); setStage('choose');
      if (snapshot.failed_ports.length) setError('Часть портов недоступна. Список может быть неполным.');
    } catch (failure) {
      if (!controller.signal.aborted) { fail(failure); setStage('start'); }
    } finally {
      if (id) { if (scan.current === id) scan.current = null; await api.stopNetworkScan(id).catch(() => {}); }
      if (request.current === controller) { request.current = null; busy.current = false; }
    }
  }
  async function verify() {
    if (!selected.length || selected.length > MAX_SELECTION || busy.current) return;
    busy.current = true; setStage('verify'); setError(''); setChecked([]); setConfirmed(false);
    const controller = new AbortController(); request.current = controller;
    const results: Checked[] = []; let nextAnnouncement = 0;
    try {
      for (const candidate of candidates.filter(row => selected.includes(row.device.id))) {
        await pause(Math.max(0, nextAnnouncement - Date.now()), controller.signal);
        setProgress('Проверяем ' + (results.length + 1) + ' из ' + selected.length + ': ' + candidate.device.name);
        try {
          const finding = await api.findLocalConnection(candidate.device.id, provider, address, controller.signal, 3);
          if (controller.signal.aborted) return;
          if (finding.verified !== true || finding.requested_device_id !== candidate.device.id || finding.interface_address !== address ||
              finding.connection_device_id !== finding.device.device_id || !finding.finding_id || !Object.hasOwn(actions, finding.action) ||
              !['direct', 'gateway'].includes(finding.route) || (finding.route === 'direct' && finding.connection_device_id !== candidate.device.id) ||
              !Array.isArray(finding.device.changed_fields) || !Array.isArray(finding.device.aliases) ||
              !Number.isFinite(finding.expires_in) || finding.expires_in <= 0) throw new Error('Сервис вернул неожиданный результат. Повторите поиск.');
          if (results.some(row => row.finding?.connection_device_id === finding.connection_device_id)) throw new Error('Это подключение уже показано для другого выбранного устройства.');
          results.push({ candidate, finding, expiresAt: Date.now() + Math.min(300, finding.expires_in) * 1000 });
        } catch (failure) {
          if (controller.signal.aborted) return;
          if (failure instanceof ApiError && failure.status === 401) { setStage('choose'); fail(failure); return; }
          results.push({ candidate, error: message(failure) });
        }
        setChecked([...results]);
        nextAnnouncement = Date.now() + 10_500; // Space announcements from completion, including server preparation time.
      }
      if (!controller.signal.aborted) { setNow(Date.now()); setStage('confirm'); }
    } catch (failure) {
      if (!controller.signal.aborted) { fail(failure); setStage('choose'); }
    } finally {
      if (request.current === controller) { request.current = null; busy.current = false; }
    }
  }
  async function save() {
    if (busy.current || !confirmed || !valid.length || expired || !connected) return;
    const batch = checked.filter(row => row.finding);
    if (batch.some(row => row.expiresAt! <= Date.now())) { setNow(Date.now()); return; }
    busy.current = true; setStage('save'); setError(''); callbacks.current.onLock(true);
    const results: Outcome[] = checked.filter(row => !row.finding).map(row => ({ id: row.candidate.device.id, name: row.candidate.device.name, message: row.error!, saved: false }));
    try {
      for (const row of batch) {
        if (!mounted.current) break;
        const finding = row.finding!;
        setProgress('Сохраняем ' + finding.device.name);
        if (row.expiresAt! <= Date.now()) {
          results.push({ id: row.candidate.device.id, name: finding.device.name, message: 'Срок проверки истёк. Нужен новый поиск.', saved: false }); continue;
        }
        try {
          const result = await api.saveLocalConnection(finding.finding_id);
          if (!mounted.current) break;
          setInventory(current => current ? { ...current, devices: [...current.devices.filter(item => item.device_id !== result.device.device_id), result.device] } : current);
          results.push({ id: row.candidate.device.id, name: result.device.name, message: savedActions[result.action], saved: true });
        } catch (failure) {
          if (!mounted.current) break;
          results.push({ id: row.candidate.device.id, name: finding.device.name, message: failure instanceof ApiError ? failure.message : 'Ответ не получен. Подключение могло сохраниться; нужен новый поиск для проверки.', saved: false });
          if (failure instanceof ApiError && failure.status === 401) { callbacks.current.onAuthError(); break; }
          // An ambiguous write is never automatically retried.
        }
      }
      if (mounted.current) { setOutcomes(results); setChecked([]); setConfirmed(false); setStage('done'); }
    } finally { busy.current = false; callbacks.current.onLock(false); }
  }
  const step = stage === 'start' || stage === 'search' ? 0 : stage === 'choose' || stage === 'verify' ? 1 : stage === 'confirm' || stage === 'save' ? 2 : 3;
  const visiblePending = pending.filter(device => {
    const item = local.find(row => row.device_id === device.id);
    return [device.name, ...(device.aliases || []), item?.name, ...(item?.aliases || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  return <section className="card local-connections-page" aria-labelledby="local-connections-heading">
    <p className="eyebrow">Домашняя сеть</p><h1 id="local-connections-heading">Локальные подключения</h1>
    <ol className="connection-steps" aria-label="Этапы настройки">{['Сеть', 'Найденные устройства', 'Подтверждение', 'Результат'].map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {stage !== 'start' && <p className="help">Сеть: {interfaces.find(row => row.address === address)?.network} · IP компьютера {address}</p>}
    {!sharingReady && !developerReady && <div className="saved-summary">Сначала подключите Tuya-аккаунт. <button className="secondary" onClick={onConnections}>Открыть подключения</button></div>}
    {stage === 'start' && <>
      <h2>Где искать устройства?</h2><p className="muted">За 15 секунд соберём объявления в выбранной сети и сопоставим устройства с вашим аккаунтом. Поиск ничего не сохраняет.</p>
      <div className="local-connection-form connection-network-form">
        <label>Аккаунт<select value={provider} disabled={!ready || loading || (!sharingReady && !developerReady)} onChange={event => setProvider(event.target.value as Provider)}><option value="sharing" disabled={!sharingReady}>Smart Life / QR</option><option value="developer" disabled={!developerReady}>Tuya Developer</option></select></label>
        <label>Сеть устройства<select value={address} disabled={!connected || loading} onChange={event => setAddress(event.target.value)}><option value="">Выберите сеть</option>{interfaces.map(row => <option key={row.address} value={row.address}>{row.name} · {row.network} · IP {row.address}</option>)}</select></label>
      </div>
      <label className="local-connection-confirm"><input type="checkbox" checked={includeConfigured} disabled={!connected || loading} onChange={event => setIncludeConfigured(event.target.checked)} />Включить уже настроенные устройства для перенастройки</label>
      <p className="help">{includeConfigured ? 'Будем искать все устройства аккаунта, включая уже настроенные. Изменения применятся только после подтверждения.' : 'Будем искать только устройства без настроенного локального подключения.'}{connected && !loading && ' Нужно настроить: ' + pending.length + ' · Настроено: ' + (devices.length - pending.length)}</p>
      <div className="local-connection-actions"><button disabled={!connected || loading || !address} onClick={() => void search()}>Найти устройства</button><button className="secondary" disabled={!connected || loading} onClick={() => setRevision(value => value + 1)}>Обновить списки</button></div>
      {connected && !loading && !interfaces.length && <p className="help">Частные IPv4-сети не найдены. Подключите компьютер с сервисом к нужной сети.</p>}
    </>}
    {working && <div className="connection-progress" role="status"><span className="spinner" aria-hidden="true" /><strong>{stage === 'search' ? 'Ищем устройства · осталось ' + seconds + ' сек.' : progress}</strong><p className="help">{stage === 'search' ? 'Принимаем объявления только в выбранной сети.' : stage === 'verify' ? 'Проверяем ключ чтением состояния. Несколько устройств проверяются по очереди; это может занять несколько минут.' : 'Каждое подтверждённое подключение сохраняется отдельно.'}</p>{stage !== 'save' && <button className="secondary" onClick={() => { stop(); setChecked([]); setStage(stage === 'search' ? 'start' : 'choose'); }}>Отмена</button>}</div>}
    {stage === 'choose' && <>
      <h2>Найдено устройств: {candidates.length}</h2><p className="help">Выберите подключения для проверки. Перед сохранением покажем проверенные параметры. За один раз можно выбрать до {MAX_SELECTION} устройств.</p>
      {candidates.length > 0 && <div className="local-connection-actions"><button className="secondary" onClick={() => setSelected(candidates.slice(0, MAX_SELECTION).map(row => row.device.id))}>{candidates.length > MAX_SELECTION ? 'Выбрать первые ' + MAX_SELECTION : 'Выбрать все'}</button><button className="secondary" disabled={!selected.length} onClick={() => setSelected([])}>Снять выбор</button></div>}
      {!candidates.length && <p className="saved-summary">Подходящих устройств в этой сети не найдено. Проверьте сеть и питание. Отсутствие объявления не означает, что устройство выключено.</p>}
      <div className="connection-device-list">{candidates.map(row => <label className="connection-device-choice" key={row.device.id}><input type="checkbox" checked={selected.includes(row.device.id)} disabled={!selected.includes(row.device.id) && selected.length >= MAX_SELECTION} onChange={event => setSelected(current => event.target.checked ? [...current, row.device.id] : current.filter(id => id !== row.device.id))} /><span><strong>{row.device.name}</strong>{row.device.aliases?.length ? <small>{row.device.aliases.join(' · ')}</small> : null}<small>{row.observed.map(item => item.ip).join(', ')} · {row.configured ? 'Уже настроено' : 'Не настроено локально'}</small></span></label>)}</div>
      {excluded > 0 && <p className="help">Уже настроенных устройств пропущено: {excluded}. Чтобы включить их, измените флажок на первом шаге.</p>}
      {unknown > 0 && <p className="help">Объявлений Tuya вне выбранного аккаунта: {unknown}. Они не предлагаются для настройки.</p>}
      <div className="local-connection-actions"><button disabled={!selected.length} onClick={() => void verify()}>Проверить выбранные</button><button className="secondary" onClick={startOver}>Назад к выбору сети</button><button className="secondary" onClick={() => { setOutcomes([]); setStage('done'); }}>Завершить без сохранения</button></div>
    </>}
    {stage === 'confirm' && <>
      <h2>Подтвердите сохранение</h2><p className="help">Проверьте имена, адреса и изменения. Локальные ключи остаются на сервере. Пока ничего не сохранено. Подключения сохраняются по очереди; при ошибке уже сохранённые остаются настроенными.</p>
      {checked.map(row => <section className="local-connection-preview" key={row.candidate.device.id}>
        <h3>{row.finding?.device.name || row.candidate.device.name}</h3>
        {row.finding ? <>
          <p><strong>{actions[row.finding.action]}</strong> · Соединение проверено</p>
          {row.finding.route === 'gateway' && <p className="help">Выбрано: {row.candidate.device.name}. Сохраняется шлюз; связь с дочерним устройством этим не подтверждается.</p>}
          <dl className="local-connection-facts"><div><dt>IP устройства</dt><dd>{row.finding.device.ip}</dd></div><div><dt>Протокол Tuya</dt><dd>{row.finding.device.version}</dd></div><div><dt>Подключение</dt><dd>{row.finding.device.is_gateway ? 'Шлюз Tuya' : 'Устройство Wi-Fi'}</dd></div><div><dt>Здание</dt><dd>{inventory?.buildings.find(building => building.id === row.finding!.device.building_id)?.name || 'Не назначено'}</dd></div><div><dt>Комната</dt><dd>{inventory?.rooms.find(room => room.id === row.finding!.device.room_id)?.name || 'Не назначена'}</dd></div><div><dt>Ключ</dt><dd>Проверен · {row.finding.key_source === 'device' ? 'из данных этого устройства' : 'из данных дочернего устройства шлюза'}</dd></div></dl>
          {row.finding.device.aliases.length > 0 && <p className="help">{row.finding.device.aliases.join(' · ')}</p>}
          {row.finding.action === 'updated' && <p className="help">Изменения: {row.finding.device.changed_fields.map(key => changes[key]).join(', ')}. Имя, алиасы, комната и функции сохраняются.</p>}
          {row.finding.action === 'created' && <p className="help">Будет создано подключение с показанными именем и размещением. Функции управления настраиваются отдельно.</p>}
          <p className="help">{row.expiresAt! > now ? 'Результат действует ещё ' + Math.ceil((row.expiresAt! - now) / 1000) + ' сек.' : 'Срок результата истёк. Повторите проверку.'}</p>
        </> : <p className="field-error">{row.error}</p>}
      </section>)}
      <label className="local-connection-confirm"><input type="checkbox" checked={confirmed} disabled={!valid.length || expired} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю сохранение показанных подключений ({valid.length})</label>
      <div className="local-connection-actions"><button disabled={!confirmed || !valid.length || expired} onClick={() => void save()}>Сохранить подключения</button><button className="secondary" onClick={() => { setChecked([]); setConfirmed(false); setStage('choose'); }}>Изменить выбор</button><button className="secondary" onClick={() => { setOutcomes(checked.filter(row => row.error).map(row => ({ id: row.candidate.device.id, name: row.candidate.device.name, message: row.error!, saved: false }))); setChecked([]); setConfirmed(false); setStage('done'); }}>Завершить без сохранения</button></div>
    </>}
    {stage === 'done' && <>
      <h2>Результат настройки</h2>
      {outcomes.length ? <ul className="connection-results">{outcomes.map(row => <li key={row.id}><strong>{row.name}</strong><span className={row.saved ? 'online' : 'field-error'}>{row.message}</span></li>)}</ul> : <p className="help">Подключения не сохранялись.</p>}
      <h3>Ещё не настроены: {pending.length}</h3><p className="help">Это устройства аккаунта без полного локального подключения. Они могут быть в другой сети или не передавать объявления. Zigbee-датчики подключаются через явно назначенный шлюз и не имеют собственного IP.</p>
      <label>Поиск ненастроенных устройств<input type="search" placeholder="Название или алиас" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ul className="connection-results">{visiblePending.map(device => <li key={device.id}><strong>{device.name}</strong>{device.aliases?.length ? <span>{device.aliases.join(' · ')}</span> : null}</li>)}</ul>
      {!visiblePending.length && <p className="help">{pending.length ? 'Совпадений не найдено.' : 'Все устройства имеют локальное подключение.'}</p>}
      <div className="local-connection-actions"><button onClick={() => { startOver(); setRevision(value => value + 1); }}>Новый поиск</button></div>
    </>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {!working && <details className="network-explanation"><summary>Как работает поиск</summary><p>Только объявления с точным идентификатором устройства из выбранного Tuya-аккаунта попадают в список. Названия и алиасы берём из его данных. Наличие облачного ключа не означает, что локальное подключение настроено; сохранённая конфигурация не гарантирует текущую доступность.</p><p>После выбора сервер заново находит адрес и проверяет ключ только чтением. Сохранение требует вашего отдельного подтверждения, заново проверяет соединение и не назначает Zigbee-родителей по догадке. Результаты проверки действуют пять минут. Сбой одного сохранения не отменяет уже выполненные; повтор автоматически не отправляется.</p></details>}
  </section>;
}
