import { dateLocale, t } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, NetworkObservation, Provider } from '../api';

export function DeviceNetwork({ api, deviceId, provider, onAuthError }: {
  api: CloudApi; deviceId: string; provider: Provider | 'local'; onAuthError: () => void;
}) {
  const [open, setOpen] = useState(false), [data, setData] = useState<NetworkObservation | null>(null);
  const [error, setError] = useState('');
  const auth = useRef(onAuthError);
  auth.current = onAuthError;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null); setError('');
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 1000); return;
      }
      try {
        const result = await api.deviceNetworkObservation(deviceId, provider, controller.signal);
        if (result.device_id !== deviceId || !result.target_id || !Array.isArray(result.changes)) throw new Error(t("Сервис вернул неожиданные данные наблюдения."));
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiError && failure.status === 409 ? t("Шлюз этого устройства пока неизвестен. Сначала укажите его при добавлении устройства в дом.") : failure instanceof Error ? failure.message : t("Не удалось начать наблюдение."));
        if (failure instanceof ApiError && failure.status === 401) { auth.current(); return; }
        if (failure instanceof ApiError && failure.status === 409) return;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, api, deviceId, provider]);
  return <details className="cloud-properties device-network" onToggle={event => setOpen(event.currentTarget.open)}><summary>{t("Устройство в домашней сети")}</summary>
    <p className="help">{t("Сервис постоянно принимает сетевые объявления Tuya. Здесь показаны сохранённый IP, последнее объявление и изменения адреса устройства или его шлюза.")}</p>
    <p className="help">{t("Общий приёмник работает и при закрытых карточках. Объявления не подтверждают состояние выключателя; отсутствие объявлений не означает, что устройство выключено. IP в настройках автоматически не изменяется.")}</p>
    {data && <p role="status">{data.listening ? t("Слушаем объявления в домашней сети.") : !data.enabled ? t("Общий приём объявлений отключён в настройках сервиса.") : data.failed_ports.length ? t("Не удалось открыть приём объявлений.") : t("Запускаем приём объявлений…")}</p>}
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
      {!!data.changes.length && <><h3>{t("Последние изменения IP")}</h3><ul>{data.changes.map((change, index) => <li key={index}>{new Date(change.at).toLocaleTimeString(dateLocale())} · {change.previous_ip ? change.previous_ip + ' → ' : t("Обнаружен: ")}{change.ip}</li>)}</ul></>}
    </>}
    {error && <p role="alert">{t(error)}</p>}
  </details>;
}
