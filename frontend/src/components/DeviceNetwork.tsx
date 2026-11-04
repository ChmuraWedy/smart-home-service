import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, NetworkWatch, Provider } from '../api';

export function DeviceNetwork({ api, deviceId, provider, onAuthError }: {
  api: CloudApi; deviceId: string; provider: Provider | 'local'; onAuthError: () => void;
}) {
  const [active, setActive] = useState(false), [data, setData] = useState<NetworkWatch | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let watchId: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const update = (result: NetworkWatch) => {
      if (result.device_id !== deviceId || !result.watch_id || !Array.isArray(result.changes)) throw new Error('Сервис вернул неожиданные данные наблюдения.');
      if (!controller.signal.aborted) setData(result);
    };
    const fail = (failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof ApiError && failure.status === 409 ? 'Шлюз этого устройства пока неизвестен. Сначала укажите его при добавлении устройства в дом.' : failure instanceof ApiError && failure.status === 404 ? 'Наблюдение завершено. Можно запустить снова.' : failure instanceof Error ? failure.message : 'Не удалось начать наблюдение.');
      setActive(false);
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
    };
    const poll = async () => {
      try {
        const result = await api.networkWatch(watchId!, controller.signal);
        update(result);
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      } catch (failure) { fail(failure); }
    };
    void (async () => {
      try {
        const result = await api.startNetworkWatch(deviceId, provider, controller.signal);
        watchId = result.watch_id;
        if (controller.signal.aborted) { if (watchId) void api.stopNetworkWatch(watchId).catch(() => {}); return; }
        update(result);
        timer = setTimeout(() => void poll(), 3000);
      } catch (failure) { fail(failure); }
    })();
    return () => {
      controller.abort(); clearTimeout(timer);
      if (watchId) void api.stopNetworkWatch(watchId).catch(() => {});
    };
  }, [active, api, deviceId, provider, onAuthError]);
  return <details className="cloud-properties device-network"><summary>Устройство в домашней сети</summary>
    <p className="help">Наблюдение за сетевыми объявлениями Tuya с компьютера, где работает сервис. Показывает IP и его изменения. Для устройства за шлюзом отслеживается шлюз. Компьютер должен быть в той же домашней сети.</p>
    <button className="secondary compact" onClick={() => { setError(''); if (!active) setData(null); setActive(!active); }}>{active ? 'Остановить наблюдение' : 'Наблюдать в сети'}</button>
    <p className="help">Приём объявлений не опрашивает устройство. Отсутствие объявлений не означает, что устройство выключено. Наблюдение длится до 15 минут и останавливается при закрытии карточки. Настройки IP автоматически не изменяются.</p>
    {active && <p role="status">{data?.listening ? 'Слушаем объявления в домашней сети.' : data?.failed_ports.length ? 'Не удалось открыть приём объявлений.' : 'Запускаем приём объявлений…'}</p>}
    {data && <>
      <dl>
        <div><dt>Отслеживаем</dt><dd>{data.route === 'gateway' ? 'Шлюз устройства' : 'Само устройство'} · <code>{data.target_id}</code></dd></div>
        <div><dt>IP в настройках</dt><dd>{data.configured_ip || 'Не задан'}</dd></div>
        <div><dt>Обнаруженный IP</dt><dd>{data.observed_ip || 'Объявлений пока нет'}</dd></div>
        <div><dt>Последнее объявление</dt><dd>{data.last_seen ? new Date(data.last_seen).toLocaleString('ru-RU') : 'Пока нет'}</dd></div>
        <div><dt>Получено объявлений</dt><dd>{data.packets}</dd></div>
      </dl>
      {data.configured_ip && data.observed_ip && data.configured_ip !== data.observed_ip && <p className="saved-summary">Обнаруженный IP отличается от сохранённого в настройках.</p>}
      {!!data.failed_ports.length && <p role="alert">Часть приёма недоступна: UDP {data.failed_ports.join(', ')}. Проверьте, не занят ли порт другим приложением.</p>}
      {!!data.changes.length && <><h3>История IP за это наблюдение</h3><ul>{data.changes.map((change, index) => <li key={index}>{new Date(change.at).toLocaleTimeString('ru-RU')} · {change.previous_ip ? change.previous_ip + ' → ' : 'Обнаружен: '}{change.ip}</li>)}</ul></>}
    </>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
