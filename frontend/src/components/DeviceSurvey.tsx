import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, JsonValue, Provider } from '../api';
import { labelFor } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceDraft, Inventory, ObservationAction, ObservationReading, ObservationSession, Placement, LocalDevice } from '../home-api';

const actions: Record<ObservationAction, { label: string; prompt: string }> = {
  observe: { label: 'Наблюдение', prompt: 'Получим исходное состояние. Затем выберите действие, которое хотите проверить.' },
  power: { label: 'Включение и выключение', prompt: 'Включите устройство физической кнопкой или в Smart Life. Подождите показания, затем выключите и снова подождите.' },
  brightness: { label: 'Яркость', prompt: 'Измените яркость в Smart Life, подождите показания, затем выберите другое значение.' },
  temperature: { label: 'Цветовая температура', prompt: 'Выберите тёплый, затем холодный свет в Smart Life. Между действиями дождитесь новых показаний.' },
  color: { label: 'Цвет', prompt: 'Выберите два разных цвета в Smart Life. Между действиями дождитесь новых показаний.' },
  sensor: { label: 'Датчик', prompt: 'Вызовите событие, например движение, открытие или изменение освещённости. Спящий датчик может передать показания с задержкой.' },
  button: { label: 'Кнопка или пульт', prompt: 'Нажмите нужную кнопку, дождитесь отчёта, затем повторите. Некоторые пульты передают события только в облако.' },
};
const textValue = (value: JsonValue) => value === true ? 'Вкл / да' : value === false ? 'Выкл / нет' : value === null ? 'Нет значения' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const title = (row: ObservationReading) => row.code ? labelFor(row.code) : 'Параметр ' + (row.dp ? 'DP ' + row.dp : row.key);
const timeLabel = (stamp: string | null) => stamp ? new Date(stamp).toLocaleString('ru-RU') : 'Время отчёта не указано';

export function DeviceSurvey({ api, inventory, device, provider, placement, cloudDevices = [], gatewayPlacements = [], gatewayOnly = false, onSaved, onClose, onAuthError, existing }: {
  api: HomeApi; inventory: Inventory; device?: CloudDevice; provider?: Provider;
  placement?: Placement; cloudDevices?: CloudDevice[]; gatewayPlacements?: Placement[];
  gatewayOnly?: boolean; onSaved?: (device: LocalDevice) => void;
  existing?: LocalDevice;
  onClose: () => void; onAuthError: () => void;
}) {
  const [step, setStep] = useState<'configure' | 'observe' | 'review'>('configure');
  const [name, setName] = useState(existing?.name || device?.name || ''), [id, setId] = useState(existing?.device_id || device?.id || '');
  const fixedGateway = gatewayOnly || device?.category === 'wg2';
  const [kind, setKind] = useState(fixedGateway ? 'gateway' : device?.sub ? 'zigbee' : 'wifi');
  const [ip, setIp] = useState(''), [version, setVersion] = useState('3.5'), [key, setKey] = useState('');
  const [confirmedIp, setConfirmedIp] = useState(false);
  const [parent, setParent] = useState(''), [cid, setCid] = useState(device?.node_id || '');
  const [room, setRoom] = useState(placement?.room_id ? String(placement.room_id) : ''), [building, setBuilding] = useState(placement?.building_id ? String(placement.building_id) : ''), [aliases, setAliases] = useState('');
  const [mode, setMode] = useState<'local' | 'cloud'>('local');
  const [observation, setObservation] = useState<ObservationSession | null>(null);
  const [action, setAction] = useState<ObservationAction>('observe'), actionRef = useRef(action);
  actionRef.current = action;
  const [paused, setPaused] = useState(false), [hidden, setHidden] = useState(document.hidden);
  const [busy, setBusy] = useState(false), [polling, setPolling] = useState(false), [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false), [writeChoices, setWriteChoices] = useState<Record<string, boolean>>({});
  const writable = observation?.readings.filter(row => row.can_write && writeChoices[row.key] !== false).map(row => row.key) || [];
  const sessionRef = useRef<string | null>(null), mounted = useRef(true), starting = useRef<AbortController | null>(null);
  const [expired, setExpired] = useState(false);
  const [savedGateways, setSavedGateways] = useState<LocalDevice[]>([]);
  const [gatewaySetup, setGatewaySetup] = useState<{ device?: CloudDevice } | null>(null);
  const availableInventory = { ...inventory, devices: [...inventory.devices, ...savedGateways] };
  const gateways = availableInventory.devices.filter(item => item.is_gateway && item.transport === 'wifi' && item.parent_id === null);
  // Tuya's gateway category identifies candidates, not a sensor's actual parent.
  // Sharing can mark gateways themselves as sub=true, so that flag must not
  // hide gateway candidates. Local connectivity is verified by the setup wizard.
  // Only devices from the selected provider are supplied by ControlCenter.
  const cloudGateways = cloudDevices.filter(item => item.category === 'wg2' && !availableInventory.devices.some(local => local.device_id === item.id));
  const selectedCloudGateway = cloudGateways.find(item => 'cloud:' + item.id === parent);
  const rooms = inventory.rooms.filter(item => !building || String(item.building_id) === building);
  const childReady = Boolean(existing) || kind !== 'zigbee' || Boolean(gateways.some(item => String(item.id) === parent && item.enabled) && cid.trim());
  const localReady = Boolean(existing) || (kind === 'zigbee' ? childReady : Boolean(ip.trim() && version && (key || device?.has_local_key)));
  const sessionId = observation?.session_id;
  const gatewayProof = observation?.gateway_verification;
  const canDiscover = kind === 'gateway' && Boolean(device && provider) && mode === 'local';

  useEffect(() => {
    mounted.current = true;
    const visibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false; starting.current?.abort();
      document.removeEventListener('visibilitychange', visibility);
      if (sessionRef.current) void api.cancelObservation(sessionRef.current).catch(() => {});
    };
  }, [api]);

  function report(failure: unknown) {
    if (!mounted.current) return;
    setError(failure instanceof Error ? failure.message : 'Не удалось выполнить опрос.');
    if (failure instanceof ApiError && failure.status === 401) onAuthError();
  }

  useEffect(() => {
    if (!sessionId || step !== 'observe' || paused || hidden || expired) { setPolling(false); return; }
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const interval = (observation?.interval_seconds || 5) * 1000;
    async function poll() {
      setPolling(true);
      try {
        const result = await api.observationSample(sessionId!, actionRef.current, controller.signal);
        if (stopped) return;
        if (result.session_id !== sessionId || result.device_id !== id) throw new Error('Сервис вернул другое устройство.');
        setObservation(result); setError('');
      } catch (failure) {
        if (stopped) return;
        report(failure);
        if (failure instanceof ApiError && [401, 404, 409].includes(failure.status)) { setExpired(true); return; }
      } finally { if (!stopped) setPolling(false); }
      if (!stopped) timer = setTimeout(() => void poll(), interval);
    }
    timer = setTimeout(() => void poll(), observation?.sample_count ? interval : 0);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [api, sessionId, step, paused, hidden, expired]);

  async function begin(discoverKey = false) {
    if (busy || !childReady || (discoverKey ? !canDiscover || !confirmedIp || !ip.trim() : mode === 'local' && !localReady)) return;
    setBusy(true); setError('');
    const controller = new AbortController(); starting.current = controller;
    const draft: DeviceDraft = {
      name: name.trim(), device_id: id.trim(), transport: kind === 'zigbee' ? 'zigbee' : 'wifi', is_gateway: kind === 'gateway',
      ip: kind === 'zigbee' ? null : ip.trim() || null, version: kind === 'zigbee' ? null : version || null,
      parent_id: kind === 'zigbee' && parent ? Number(parent) : null, cid: kind === 'zigbee' ? cid.trim() || null : null,
      ...(key && kind !== 'zigbee' && !discoverKey ? { local_key: key } : {}),
    };
    try {
      const result = existing ? await api.beginFunctionSetup(existing.id, provider, controller.signal) : discoverKey
        ? await api.discoverGatewayKey(draft, provider!, controller.signal)
        : await api.beginObservation(draft, mode, provider, controller.signal);
      if (!mounted.current) { void api.cancelObservation(result.session_id).catch(() => {}); return; }
      sessionRef.current = result.session_id; setKey(''); setId(draft.device_id); setObservation(result);
      setWriteChoices({}); setReviewed(false); setExpired(false); setPaused(false); setStep(result.gateway_verification ? 'review' : 'observe');
    } catch (failure) { report(failure); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function restart() {
    if (busy) return;
    setBusy(true);
    try { if (sessionRef.current) await api.cancelObservation(sessionRef.current); }
    catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) { report(failure); setBusy(false); return; } }
    sessionRef.current = null; setObservation(null); setStep('configure'); setError(''); setBusy(false);
  }

  async function save() {
    if (!observation || !reviewed || busy || expired) return;
    setBusy(true); setError('');
    try {
      const saved = await api.registerObservation(observation.session_id, {
        name: name.trim(), aliases: aliases.split(',').map(value => value.trim()).filter(Boolean),
        room_id: room ? Number(room) : null, building_id: building ? Number(building) : null, reviewed: true,
        writable: writable.filter(value => observation.readings.some(row => row.key === value && row.can_write)),
      });
      sessionRef.current = null; if (onSaved) onSaved(saved); else onClose();
    } catch (failure) { report(failure); if (mounted.current) setBusy(false); }
  }

  const placementFields = <div className="survey-form-grid">
    <label>Название<input value={name} maxLength={120} onChange={event => setName(event.target.value)} required /></label>
    <label>Алиасы через запятую<input aria-label="Алиасы через запятую" value={aliases} onChange={event => setAliases(event.target.value)} placeholder="kitchen_light, main_light" /><span className="help">Латинские буквы, цифры, . _ -; начинайте с буквы. Название тоже станет алиасом.</span></label>
    <label>Здание<select value={building} onChange={event => { setBuilding(event.target.value); setRoom(''); }}><option value="">Не выбрано</option>{inventory.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Комната<select value={room} onChange={event => setRoom(event.target.value)}><option value="">Не выбрана</option>{rooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  </div>;

  if (gatewaySetup) return <DeviceSurvey api={api} inventory={availableInventory} device={gatewaySetup.device} provider={gatewaySetup.device ? provider : undefined} gatewayOnly
    placement={gatewayPlacements.find(item => item.device_id === gatewaySetup.device?.id)}
    onAuthError={onAuthError} onClose={() => setGatewaySetup(null)} onSaved={saved => {
      setSavedGateways(current => [...current.filter(item => item.id !== saved.id), saved]);
      setParent(String(saved.id)); setGatewaySetup(null);
    }} />;

  return <section className="card device-survey" aria-labelledby="survey-heading">
    <div className="card-heading"><div><p className="eyebrow">{existing ? 'Функции устройства' : 'Локальное подключение'} · {step === 'configure' ? '1 / 3' : step === 'observe' ? '2 / 3' : '3 / 3'}</p><h2 id="survey-heading">{step === 'configure' ? existing ? 'Настроить функции устройства' : 'Настроить локальное подключение' : step === 'observe' ? 'Проверьте устройство' : 'Проверьте результаты'}</h2></div><button className="secondary compact" disabled={busy} onClick={onClose}>Отмена</button></div>
    {step === 'configure' ? <form onSubmit={event => { event.preventDefault(); void begin(); }}>
      {existing ? <div className="saved-summary"><strong>{existing.name}</strong><p>Прочитаем реальные локальные параметры и сопоставим их со схемой Tuya. Устройство не переключается автоматически. Все проверенные функции выбраны для управления по умолчанию. Можно снять отдельные флажки перед подтверждением сохранения. Имя, алиасы, комната, ключ и адрес сохранятся.</p>{!provider && <p className="help">Аккаунт Tuya недоступен: параметры можно сохранить только для чтения. Для распознавания переключателей подключите Smart Life или Tuya Developer.</p>}</div> : <><p className="help">Необязательная настройка управления по домашней сети. Проверим связь и изменения показаний при ваших действиях. Локальное подключение сохранится только после проверки.</p>
      {device && <p className="help">Устройство уже доступно через Smart Life. Для обычного управления этот мастер не нужен.</p>}
      {placement && <p className="help">Здание и комната взяты из Smart Life. Изменения здесь относятся только к локальному подключению.</p>}
      {placementFields}
      <div className="survey-form-grid">
        <label>Tuya device ID<input value={id} readOnly={Boolean(device)} required maxLength={128} onChange={event => setId(event.target.value)} /></label>
        <label>Подключение устройства<select value={kind} disabled={fixedGateway} onChange={event => setKind(event.target.value)}>{fixedGateway ? <option value="gateway">Tuya шлюз</option> : <><option value="wifi">Wi-Fi устройство</option><option value="gateway">Tuya шлюз</option><option value="zigbee">Zigbee через шлюз</option></>}</select></label>
        {kind === 'zigbee' ? <><label>Шлюз<select value={parent} onChange={event => setParent(event.target.value)}><option value="">{gateways.length || cloudGateways.length ? 'Выберите шлюз' : 'Нет настроенных шлюзов'}</option>{gateways.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{!item.enabled && ' · отключён'}</option>)}{cloudGateways.map(item => <option key={item.id} value={'cloud:' + item.id}>{item.name} · требуется локальная настройка</option>)}</select></label><label>cid / node_id<input value={cid} maxLength={128} onChange={event => setCid(event.target.value)} /></label></> : <><label>IP в домашней сети<input value={ip} onChange={event => { setIp(event.target.value); setConfirmedIp(false); }} placeholder="192.168.1.40" /></label><label>Версия локального протокола<select value={version} onChange={event => setVersion(event.target.value)}>{['3.1', '3.2', '3.3', '3.4', '3.5'].map(value => <option key={value}>{value}</option>)}</select></label>{device?.has_local_key ? <p className="saved-summary">Локальный ключ доступен на сервере.</p> : <label>Локальный ключ<input type="password" autoComplete="off" value={key} maxLength={16} onChange={event => setKey(event.target.value)} /><span className="help">16 символов. Ключ не отображается в ответах сервиса.</span></label>}</>}
        <label>Источник показаний<select value={mode} onChange={event => setMode(event.target.value as 'local' | 'cloud')}><option value="local">Локальный опрос + подписи Tuya</option>{provider && !gatewayOnly && <option value="cloud">Облачные отчёты Tuya</option>}</select></label>
      </div>
      {kind === 'zigbee' && <div className="saved-summary">
        {selectedCloudGateway ? <><p>«{selectedCloudGateway.name}» найден в Smart Life. Сначала настройте его локальное подключение: понадобятся IP, версия протокола и локальный ключ, если его нет на сервере. После сохранения вернёмся к датчику.</p><p className="help">Выберите шлюз, к которому действительно подключён датчик. Smart Life не передал эту связь приложению.</p><button type="button" className="secondary compact" onClick={() => setGatewaySetup({ device: selectedCloudGateway })}>Настроить выбранный шлюз</button></> : !gateways.length ? <p>{cloudGateways.length ? 'Выберите шлюз из Smart Life и настройте его локальное подключение.' : 'В этом подключении Smart Life шлюзы не найдены. Для локального управления датчиком сначала настройте его шлюз.'} Для обычного управления через Smart Life этот мастер не нужен.</p> : null}
        <button type="button" className="secondary compact" onClick={() => setGatewaySetup({})}>Настроить другой шлюз вручную</button>
      </div>}
      {gatewayOnly && <p className="help">Настраиваем шлюз. После сохранения вернёмся к подключению датчика; введённые данные сохранятся.</p>}
      {mode === 'cloud' && <p className="saved-summary">Облачные отчёты могут приходить с задержкой. Они помогут увидеть изменения; для проверки локальных DP понадобится отдельный локальный опрос.</p>}
      {canDiscover && <div className="saved-summary">
        <p>Если ключ шлюза отсутствует, проверим ключи дочерних устройств из выбранного аккаунта Smart Life. Проверка читает состояние только по указанному IP и подбирает версию 3.3–3.5. Ключ останется на сервере.</p>
        <p className="help">Укажите IP этого шлюза из списка клиентов роутера. Ответ по адресу подтверждает ключ, но не название шлюза и не связь с датчиками.</p>
        <label className="survey-checkbox"><input type="checkbox" checked={confirmedIp} onChange={event => setConfirmedIp(event.target.checked)} />Я проверил IP шлюза в роутере</label>
        <button type="button" className="secondary" disabled={busy || !confirmedIp || !ip.trim() || !name.trim() || !['3.3', '3.4', '3.5'].includes(version)} onClick={() => void begin(true)}>Найти ключ и проверить шлюз</button>
      </div>}
      </>}
      <button disabled={busy || !name.trim() || !id.trim() || !childReady || (mode === 'local' && !localReady)}>Начать опрос</button>
    </form> : <>
      {gatewayProof ? <div className="saved-summary"><strong>Защищённое соединение со шлюзом подтверждено</strong><p>{gatewayProof.ip} · Протокол {gatewayProof.version}</p><p>{gatewayProof.key_source === 'child' ? 'Подошёл ключ из метаданных дочернего устройства Smart Life.' : 'Подтверждён ключ шлюза из Smart Life.'} Ключ не отображается в браузере.</p><p className="help">Шлюз может не иметь собственных показаний. После сохранения выберите его при настройке датчика, если это его действительный шлюз. Результат действует 15 минут.</p></div> : <p className="help">{name} · {observation?.mode === 'local' ? 'В домашней сети' : 'Через интернет'} · Получено выборок: {observation?.sample_count || 0}</p>}
      {step === 'observe' && <>
        <div className="survey-prompt"><label>Что проверяем<select value={action} onChange={event => setAction(event.target.value as ObservationAction)}>{Object.entries(actions).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label><p>{actions[action].prompt}</p><p className="help">Выбор действия помечает замеченные изменения; он не определяет назначение параметра автоматически.</p></div>
        <div className="survey-toolbar"><span role="status">{expired ? 'Опрос остановлен. Начните заново.' : hidden ? 'Опрос приостановлен, пока вкладка скрыта.' : paused ? 'Опрос на паузе.' : polling ? 'Читаем состояние…' : 'Ожидаем следующую выборку…'}</span><button className="secondary compact" disabled={expired} onClick={() => setPaused(value => !value)}>{paused ? 'Продолжить' : 'Пауза'}</button></div>
        <p className="help">Сервис читает только выбранное устройство каждые {observation?.interval_seconds} сек. Короткие события между чтениями могут быть пропущены. Опрос действует 15 минут.</p>
      </>}
      {step === 'review' && <>{!existing && placementFields}{!gatewayProof && <><p className="saved-summary">Все функции, подтверждённые Tuya и локальным ответом, выбраны для управления по умолчанию. Снимите флажки у ненужных функций. Неизвестные параметры останутся только для чтения. Изменения сохранятся после вашего подтверждения.</p>{observation?.mode === 'cloud' && <p className="help">Облачные значения не сохраняются как локальное состояние или capabilities. Управление через аккаунт Tuya остаётся доступным.</p>}</>}</>}
      {!gatewayProof && <><div className="survey-readings"><h3>Последние показания</h3>{!observation?.readings.length ? <p className="empty-state">Пока нет показаний. Если устройство спит, попробуйте разбудить его или выбрать облачные отчёты.</p> : <ul>{observation.readings.map(row => <li key={row.key}><div><strong>{title(row)}</strong><span className="help">{row.dp ? 'DP ' + row.dp : 'Номер DP не известен'}{row.code && ' · ' + row.code} · {timeLabel(row.received_at)}</span></div><output>{textValue(row.value)}</output>{step === 'review' && row.can_write && <label className="survey-checkbox"><input type="checkbox" checked={writable.includes(row.key)} onChange={event => setWriteChoices(current => ({ ...current, [row.key]: event.target.checked }))} />Разрешить управление: {title(row)}</label>}</li>)}</ul>}</div>
      <div className="survey-history"><h3>Замеченные изменения <span className="count">{observation?.changes.length || 0}</span></h3>{!observation?.changes.length ? <p className="help">Изменений пока нет. Исходное состояние не считается изменением.</p> : <ol>{[...observation.changes].reverse().map((row, index) => <li key={index}><span className="help">{timeLabel(row.detected_at)} · {actions[row.action as ObservationAction]?.label || 'Наблюдение'}</span><strong>{title(row)}</strong><span>{textValue(row.previous)} → {textValue(row.value)}</span></li>)}</ol>}</div>
      </>}<div className="survey-footer">{step === 'observe' ? <><button className="secondary" disabled={busy || polling} onClick={() => void restart()}>Изменить подключение</button><button disabled={expired || polling || !observation?.readings.length} onClick={() => { setStep('review'); setReviewed(false); }}>Перейти к сохранению</button></> : <><label className="survey-checkbox"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{gatewayProof ? 'Я проверил IP шлюза и выбранные параметры' : 'Я проверил показания и выбранные параметры'}</label><button className="secondary" disabled={busy} onClick={() => gatewayProof ? void restart() : setStep('observe')}>{gatewayProof ? 'Изменить подключение' : 'Продолжить опрос'}</button><button disabled={!reviewed || busy || expired || !name.trim()} onClick={() => void save()}>{existing ? 'Сохранить функции' : 'Сохранить локальное подключение'}</button></>}</div>
    </>}
    {busy && <p role="status" className="help">{step === 'configure' && canDiscover ? 'Проверяем подключение… Это может занять около 30 секунд.' : 'Выполняем запрос…'}</p>}{error && <p role="alert" className="field-error">{error}</p>}
  </section>;
}
