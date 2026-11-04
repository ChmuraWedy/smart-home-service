import { dateLocale, t } from "../i18n";
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
      if (result.device_id !== deviceId || !result.watch_id || !Array.isArray(result.changes)) throw new Error(t("Сервис вернул неожиданные данные наблюдения."));
      if (!controller.signal.aborted) setData(result);
    };
    const fail = (failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof ApiError && failure.status === 409 ? t("Шлюз этого устройства пока неизвестен. Сначала укажите его при добавлении устройства в дом.") : failure instanceof ApiError && failure.status === 404 ? t("Наблюдение завершено. Можно запустить снова.") : failure instanceof Error ? failure.message : t("Не удалось начать наблюдение."));
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
  return <details className="cloud-properties device-network"><summary>{t("Устройство в домашней сети")}</summary>
    <p className="help">{t("Наблюдение за сетевыми объявлениями Tuya с компьютера, где работает сервис. Показывает IP и его изменения. Для устройства за шлюзом отслеживается шлюз. Компьютер должен быть в той же домашней сети.")}</p>
    <button className="secondary compact" onClick={() => { setError(''); if (!active) setData(null); setActive(!active); }}>{active ? t("Остановить наблюдение") : t("Наблюдать в сети")}</button>
    <p className="help">{t("Приём объявлений не опрашивает устройство. Отсутствие объявлений не означает, что устройство выключено. Наблюдение длится до 15 минут и останавливается при закрытии карточки. Настройки IP автоматически не изменяются.")}</p>
    {active && <p role="status">{data?.listening ? t("Слушаем объявления в домашней сети.") : data?.failed_ports.length ? t("Не удалось открыть приём объявлений.") : t("Запускаем приём объявлений…")}</p>}
    {data && <>
      <dl>
        <div><dt>{t("Отслеживаем")}</dt><dd>{data.route === 'gateway' ? t("Шлюз устройства") : t("Само устройство")} · <code>{data.target_id}</code></dd></div>
        <div><dt>{t("IP в настройках")}</dt><dd>{data.configured_ip || t("Не задан")}</dd></div>
        <div><dt>{t("Обнаруженный IP")}</dt><dd>{data.observed_ip || t("Объявлений пока нет")}</dd></div>
        <div><dt>{t("Последнее объявление")}</dt><dd>{data.last_seen ? new Date(data.last_seen).toLocaleString(dateLocale()) : t("Пока нет")}</dd></div>
        <div><dt>{t("Получено объявлений")}</dt><dd>{data.packets}</dd></div>
      </dl>
      {data.configured_ip && data.observed_ip && data.configured_ip !== data.observed_ip && <p className="saved-summary">{t("Обнаруженный IP отличается от сохранённого в настройках.")}</p>}
      {!!data.failed_ports.length && <p role="alert">{t("Часть приёма недоступна: UDP") + " "}{data.failed_ports.join(', ')}{t(". Проверьте, не занят ли порт другим приложением.")}</p>}
      {!!data.changes.length && <><h3>{t("История IP за это наблюдение")}</h3><ul>{data.changes.map((change, index) => <li key={index}>{new Date(change.at).toLocaleTimeString(dateLocale())} · {change.previous_ip ? change.previous_ip + ' → ' : t("Обнаружен: ")}{change.ip}</li>)}</ul></>}
    </>}
    {error && <p role="alert">{t(error)}</p>}
  </details>;
}
