import { dateLocale, localizeMessages, t } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, NetworkInterface, NetworkScan } from '../api';

const protocols: Record<string, string> = localizeMessages({ tuya: 'Tuya', mdns: 'mDNS', ssdp: 'SSDP', arp: 'Таблица соседей', unknown: 'Не распознан' });
const seen = (at: string | null) => at ? new Date(at).toLocaleTimeString(dateLocale()) : t("Нет пакетов");

export function NetworkPage({ api, ready, onAuthError }: { api: CloudApi; ready: boolean; onAuthError: () => void }) {
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]), [selected, setSelected] = useState('');
  const [interfaceVersion, setInterfaceVersion] = useState(0), [loadingInterfaces, setLoadingInterfaces] = useState(false);
  const [active, setActive] = useState(false), [data, setData] = useState<NetworkScan | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [requesting, setRequesting] = useState(false);
  const auth = useRef(onAuthError), request = useRef<AbortController | null>(null);
  auth.current = onAuthError;

  useEffect(() => {
    const controller = new AbortController();
    setActive(false); setSelected(''); setInterfaces([]); setData(null);
    if (!ready) return;
    setLoadingInterfaces(true);
    void api.networkInterfaces(controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(rows)) throw new Error(t("Не удалось прочитать список сетей."));
      setInterfaces(rows);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : t("Не удалось прочитать список сетей."));
      if (failure instanceof ApiError && failure.status === 401) auth.current();
    }).finally(() => { if (!controller.signal.aborted) setLoadingInterfaces(false); });
    return () => controller.abort();
  }, [api, ready, interfaceVersion]);

  useEffect(() => {
    if (!active || !ready || !selected) return;
    const controller = new AbortController();
    let id: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const update = (result: NetworkScan) => {
      if (!result.scan_id || (id && result.scan_id !== id) || !Array.isArray(result.devices) || !Array.isArray(result.events)) throw new Error(t("Сервис вернул неожиданные данные сети."));
      if (!controller.signal.aborted) setData(current => current?.scan_id === result.scan_id && current.packets > result.packets ? current : result);
    };
    const fail = (failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : t("Не удалось наблюдать за сетью."));
      setActive(false);
      if (failure instanceof ApiError && failure.status === 401) auth.current();
    };
    const poll = async () => {
      try {
        update(await api.networkScan(id!, controller.signal));
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      } catch (failure) { fail(failure); }
    };
    const visibility = () => {
      if (document.hidden) { setMessage(t("Наблюдение остановлено: вкладка скрыта. Последний результат доступен для сохранения.")); setActive(false); }
    };
    document.addEventListener('visibilitychange', visibility);
    void (async () => {
      try {
        const result = await api.startNetworkScan(selected, controller.signal);
        id = result.scan_id;
        if (controller.signal.aborted) { if (id) void api.stopNetworkScan(id).catch(() => {}); return; }
        update(result);
        timer = setTimeout(() => void poll(), 1000);
      } catch (failure) { fail(failure); }
    })();
    return () => {
      controller.abort(); request.current?.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      if (id) void api.stopNetworkScan(id).catch(() => {});
    };
  }, [active, ready, api, selected]);

  async function discover() {
    if (!active || !data || requesting) return;
    const controller = new AbortController(); request.current = controller;
    setRequesting(true); setError(''); setMessage('');
    try {
      const result = await api.requestNetworkAnnouncements(data.scan_id, controller.signal);
      if (!controller.signal.aborted) {
        setData(current => current?.scan_id === result.scan_id && current.packets > result.packets ? { ...current, discovery_requests: result.discovery_requests } : result);
        setMessage(t("Запрос объявлений Tuya отправлен. Ожидаем ответы устройств."));
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : t("Не удалось запросить объявления."));
        if (failure instanceof ApiError && failure.status === 401) auth.current();
      }
    } finally { if (!controller.signal.aborted) setRequesting(false); }
  }

  function exportReport() {
    if (!data) return;
    const report = { format: 'smart-home-network-observation', version: 1, exported_at: new Date().toISOString(),
      interface: data.interface, devices: data.devices, events: data.events, packets: data.packets, recognized_packets: data.recognized_packets,
      ports: data.ports, failed_ports: data.failed_ports, neighbors_available: data.neighbors_available,
      discovery_requests: data.discovery_requests, truncated: data.truncated };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'home-network-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const search = query.trim().toLocaleLowerCase();
  const devices = (data?.devices || []).filter(row => (filter === 'all' || row.protocols.includes(filter)) && [row.ip, row.device_id, row.mac, row.hostname, ...row.services].filter(Boolean).join(' ').toLocaleLowerCase().includes(search));
  const tuya = data?.devices.filter(row => row.device_id).length || 0;
  return <section className="card network-page" aria-labelledby="network-heading">
    <div className="network-heading"><div><p className="eyebrow">{t("Домашняя сеть")}</p><h1 id="network-heading">{t("Сеть и пакеты")}</h1><p className="help">{t("Объявления устройств и соседи в сети компьютера, где работает сервис.")}</p></div><span className={'network-status ' + (active ? 'online' : '')} role="status">{active ? data?.listening ? t("Принимаем пакеты") : t("Открываем приёмник…") : t("Наблюдение остановлено")}</span></div>
    <div className="network-interface"><label>{t("Сеть для наблюдения")}<select aria-label={t("Сеть для наблюдения")} disabled={active || loadingInterfaces || !ready} value={selected} onChange={event => { setSelected(event.target.value); setData(null); setError(''); setMessage(''); }}><option value="">{loadingInterfaces ? t("Читаем интерфейсы…") : t("Выберите сеть")}</option>{interfaces.map(row => <option key={row.address} value={row.address}>{row.name} · {row.network} · IP {row.address}</option>)}</select></label><button className="secondary" disabled={active || loadingInterfaces || !ready} onClick={() => { setError(''); setInterfaceVersion(value => value + 1); }}>{t("Обновить сети")}</button></div>
    {ready && !loadingInterfaces && !interfaces.length && !error && <p className="help">{t("Частные IPv4-сети не найдены. Подключите компьютер с сервисом к нужной сети и обновите список.")}</p>}
    {data?.interface && <p className="help">{t("Сеть наблюдения:") + " "}<strong>{data.interface.network}</strong> · {data.interface.name}{" " + t("· IP компьютера") + " "}{data.interface.address}</p>}
    <div className="network-toolbar">
      <button disabled={!ready || (!active && !selected)} onClick={() => { setError(''); setMessage(''); setRequesting(false); if (!active) setData(null); setActive(value => !value); }}>{active ? t("Остановить") : t("Начать наблюдение")}</button>
      <button className="secondary" disabled={!active || !data?.ports.includes(7000) || requesting} onClick={() => void discover()}>{requesting ? t("Отправляем…") : t("Запросить объявления Tuya")}</button>
      <button className="secondary" disabled={!data} onClick={exportReport}>{t("Сохранить отчёт")}</button>
    </div>
    {!ready && <p className="saved-summary">{t("Сначала сохраните доступ к сервису в настройках подключения.")}</p>}
    <details className="network-explanation"><summary>{t("Что видно в этом наблюдении")}</summary><p>{t("Пассивно принимаем объявления Tuya, mDNS и SSDP из выбранной подсети, читаем относящиеся к ней записи таблицы соседей. Кнопка запроса отправляет только стандартное объявление поиска Tuya, через выбранный интерфейс, чтобы устройства ответили; их настройки и состояние не меняются.")}</p><p>{t("Zigbee не имеет собственного IP. Здесь можно увидеть сетевой шлюз, но по этим объявлениям нельзя доказать, что это Zigbee-шлюз, или определить его дочерние устройства. Отсутствие пакетов не означает, что устройство выключено.")}</p><p>{t("Это объявления в домашней сети, а не весь трафик между устройствами. Тип устройства показываем только по его объявлению сервиса. Сырые пакеты, ключи и содержимое TXT/HTTP не сохраняются. Результаты временные: до 15 минут, затем их можно сохранить в отчёт для дальнейшего анализа.")}</p></details>
    {error && <p role="alert" className="field-error">{t(error)}</p>}{message && <p role="status" className="help">{message}</p>}
    <div className="network-stats"><div><strong>{data?.devices.length || 0}</strong><span>{t("Адресов и устройств")}</span></div><div><strong>{tuya}</strong><span>Tuya ID</span></div><div><strong>{data?.packets || 0}</strong><span>{t("Пакетов")}</span></div><div><strong>{data?.recognized_packets || 0}</strong><span>{t("Распознано")}</span></div></div>
    {data && <p className="help">{t("Приём:") + " "}{data.ports.map(port => port === 5353 ? 'mDNS' : port === 1900 ? 'SSDP' : 'Tuya ' + port).join(' · ') || t("порты ещё не открыты")}{active && t(" · Осталось {0} мин.", [Math.ceil(data.remaining_seconds / 60)])}{data.neighbors_available === false && t(" · Таблица соседей недоступна.")}</p>}
    {!!data?.failed_ports.length && <p className="field-error">{t("Не удалось открыть UDP") + " "}{data.failed_ports.join(', ')}{t(". По остальным портам наблюдение продолжается.")}</p>}
    {data?.truncated && <p className="help">{t("Достигнут предел 256 устройств. Сохраните отчёт и начните новое наблюдение.")}</p>}
    <div className="network-filters"><label>{t("Поиск по IP, MAC, ID или сервису")}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><label>{t("Источник")}<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t("Все источники")}</option>{Object.entries(protocols).filter(([key]) => key !== 'unknown').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    <h2>{t("Обнаружено в сети")}</h2>
    {!devices.length ? <p className="empty-state">{search || filter !== 'all' ? t("Нет совпадений с фильтром.") : active ? t("Ждём объявления устройств. Можно запросить объявления Tuya.") : t("Начните наблюдение, чтобы увидеть устройства.")}</p> : <div className="network-table-wrap"><table className="network-table"><thead><tr><th>{t("Адрес и идентификатор")}</th><th>{t("Источники и сервисы")}</th><th>MAC</th><th>{t("Пакеты")}</th></tr></thead><tbody>{devices.map(row => <tr key={row.device_id || row.ip}><td><strong>{row.ip}</strong>{row.hostname && <span>{row.hostname}</span>}{row.device_id && <code>{row.device_id}</code>}{row.version && <span className="help">Tuya {row.version}</span>}{row.changes.length > 0 && <details><summary>{t("Изменения IP:") + " "}{row.changes.length}</summary>{row.changes.map((change, index) => <p className="help" key={index}>{seen(change.at)} · {change.previous_ip} → {change.ip}</p>)}</details>}</td><td><span>{row.protocols.map(protocol => protocols[protocol] || protocol).join(' · ')}</span>{row.services.map(service => <code key={service}>{service}</code>)}{!row.services.length && !row.device_id && <span className="help">{t("Тип пока неизвестен")}</span>}</td><td><code>{row.mac || '—'}</code></td><td><strong>{row.packets}</strong><span className="help">{seen(row.last_seen)}</span>{!row.packets && <span className="help">{t("Запись в кеше соседей")}</span>}</td></tr>)}</tbody></table></div>}
    <details className="network-events"><summary>{t("Журнал пакетов ·") + " "}{data?.events.length || 0}</summary><p className="help">{t("Последние 200 событий, только время, отправитель, порт и распознанный протокол.")}</p>{data?.events.length ? <ol>{[...data.events].reverse().map((event, index) => <li key={index}><time>{seen(event.at)}</time><code>{event.ip}:{event.port}</code><span>{protocols[event.protocol] || event.protocol}</span>{event.device_id && <code>{event.device_id}</code>}</li>)}</ol> : <p className="help">{t("Пакетов пока нет.")}</p>}</details>
  </section>;
}
