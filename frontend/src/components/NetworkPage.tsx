import { MSG, dateLocale, localizeMessages, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, NetworkInterface, NetworkScan } from '../api';

const protocols: Record<string, string> = localizeMessages({ tuya: 'Tuya', mdns: 'mDNS', ssdp: 'SSDP', arp: MSG.NEIGHBOR_TABLE, unknown: MSG.UNRECOGNIZED });
const seen = (at: string | null) => at ? new Date(at).toLocaleTimeString(dateLocale()) : t(MSG.NO_PACKETS);

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
      if (!Array.isArray(rows)) throw new Error(t(MSG.COULD_NOT_READ_THE_NETWORK_LIST));
      setInterfaces(rows);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_READ_THE_NETWORK_LIST));
      if (failure instanceof ApiError && failure.status === 401) auth.current();
    }).finally(() => { if (!controller.signal.aborted) setLoadingInterfaces(false); });
    return () => controller.abort();
  }, [api, ready, interfaceVersion]);

  useEffect(() => {
    if (!active || !ready || !selected) return;
    const controller = new AbortController();
    let id: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const update = (result: NetworkScan) => {
      if (!result.scan_id || (id && result.scan_id !== id) || !Array.isArray(result.devices) || !Array.isArray(result.events)) throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_NETWORK_DATA));
      if (!controller.signal.aborted) setData(current => current?.scan_id === result.scan_id && current.packets > result.packets ? current : result);
    };
    const fail = (failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_OBSERVE_THE_NETWORK));
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
      if (document.hidden) { setMessage(t(MSG.OBSERVATION_STOPPED_BECAUSE_THE_TAB_IS_HIDDEN)); setActive(false); }
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
        setMessage(t(MSG.TUYA_DISCOVERY_REQUEST_SENT));
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_REQUEST_ANNOUNCEMENTS));
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
  return (
    <section className="card network-page" aria-labelledby="network-heading">
      <div className="network-heading">
        <div>
          <p className="eyebrow">{t(MSG.HOME_NETWORK)}</p>
          <h1 id="network-heading">{t(MSG.NETWORK_AND_PACKETS)}</h1>
          <p className="help">{t(MSG.DEVICE_ANNOUNCEMENTS_AND_NEIGHBORS_ON_THE_SERVERS_NETWORK)}</p>
        </div>
        <span className={'network-status ' + (active ? 'online' : '')} role="status">{active ? data?.listening ? t(MSG.RECEIVING_PACKETS) : t(MSG.OPENING_RECEIVER) : t(MSG.OBSERVATION_STOPPED)}</span>
      </div>
      <p className="help">{t(MSG.TUYA_RECEPTION_RUNS_CONTINUOUSLY)}</p>
      <div className="network-interface">
        <label>{t(MSG.NETWORK_TO_OBSERVE)}
          <select aria-label={t(MSG.NETWORK_TO_OBSERVE)} disabled={active || loadingInterfaces || !ready} value={selected} onChange={event => { setSelected(event.target.value); setData(null); setError(''); setMessage(''); }}>
            <option value="">{loadingInterfaces ? t(MSG.READING_INTERFACES) : t(MSG.SELECT_A_NETWORK)}</option>
            {interfaces.map(row => <option key={row.address} value={row.address}>{row.name} · {row.network} · IP {row.address}</option>)}
          </select>
        </label>
        <button className="secondary" disabled={active || loadingInterfaces || !ready} onClick={() => { setError(''); setInterfaceVersion(value => value + 1); }}>{t(MSG.REFRESH_NETWORKS)}</button>
      </div>
      {ready && !loadingInterfaces && !interfaces.length && !error && <p className="help">{t(MSG.REFRESH_PRIVATE_IPV4_NETWORK_LIST)}</p>}
      {data?.interface && (
      <p className="help">{t(MSG.OBSERVED_NETWORK) + " "}
        <strong>{data.interface.network}</strong> · {data.interface.name}{" " + t(MSG.SERVER_IP) + " "}{data.interface.address}
      </p>
)}
      <div className="network-toolbar">
        <button disabled={!ready || (!active && !selected)} onClick={() => { setError(''); setMessage(''); setRequesting(false); if (!active) setData(null); setActive(value => !value); }}>{active ? t(MSG.STOP) : t(MSG.START_OBSERVING)}</button>
        <button className="secondary" disabled={!active || !data?.ports.includes(7000) || requesting} onClick={() => void discover()}>{requesting ? t(MSG.SENDING) : t(MSG.REQUEST_TUYA_ANNOUNCEMENTS)}</button>
        <button className="secondary" disabled={!data} onClick={exportReport}>{t(MSG.SAVE_REPORT)}</button>
      </div>
      {!ready && <p className="saved-summary">{t(MSG.SAVE_SERVICE_ACCESS_IN_CONNECTION_SETTINGS_FIRST)}</p>}
      <details className="network-explanation">
        <summary>{t(MSG.WHAT_THIS_OBSERVATION_SHOWS)}</summary>
        <p>{t(MSG.PASSIVELY_RECEIVE_TUYA_MDNS_AND_SSDP_ANNOUNCEMENTS_FROM)}</p>
        <p>{t(MSG.ZIGBEE_HAS_NO_IP_OF_ITS_OWN)}</p>
        <p>{t(MSG.THESE_ARE_HOME_NETWORK_ANNOUNCEMENTS_NOT_ALL_TRAFFIC)}</p>
      </details>
      {error && <p role="alert" className="field-error">{translateText(error)}</p>}
      {message && <p role="status" className="help">{message}</p>}
      <div className="network-stats">
        <div>
          <strong>{data?.devices.length || 0}</strong>
          <span>{t(MSG.ADDRESSES_AND_DEVICES)}</span>
        </div>
        <div>
          <strong>{tuya}</strong>
          <span>Tuya ID</span>
        </div>
        <div>
          <strong>{data?.packets || 0}</strong>
          <span>{t(MSG.PACKET_COUNT_LABEL)}</span>
        </div>
        <div>
          <strong>{data?.recognized_packets || 0}</strong>
          <span>{t(MSG.RECOGNIZED)}</span>
        </div>
      </div>
      {data && <p className="help">{t(MSG.RECEPTION) + " "}{data.ports.map(port => port === 5353 ? 'mDNS' : port === 1900 ? 'SSDP' : 'Tuya ' + port).join(' · ') || t(MSG.PORTS_NOT_OPEN_YET)}{active && t(MSG.MIN_REMAINING, [Math.ceil(data.remaining_seconds / 60)])}{data.neighbors_available === false && t(MSG.NEIGHBOR_TABLE_UNAVAILABLE)}</p>}
      {!!data?.failed_ports.length && <p className="field-error">{t(MSG.COULD_NOT_OPEN_UDP) + " "}{data.failed_ports.join(', ')}{t(MSG.OBSERVATION_CONTINUES_ON_THE_REMAINING_PORTS)}</p>}
      {data?.truncated && <p className="help">{t(MSG.THE_256_DEVICE_LIMIT_WAS_REACHED)}</p>}
      <div className="network-filters">
        <label>{t(MSG.SEARCH_BY_IP_MAC_ID_OR_SERVICE)}
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <label>{t(MSG.SOURCE)}
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">{t(MSG.ALL_SOURCES)}</option>
            {Object.entries(protocols).filter(([key]) => key !== 'unknown').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      <h2>{t(MSG.DISCOVERED_ON_NETWORK)}</h2>
      {!devices.length ? <p className="empty-state">{search || filter !== 'all' ? t(MSG.NO_MATCHES_FOR_THIS_FILTER) : active ? t(MSG.WAITING_FOR_DEVICE_ANNOUNCEMENTS) : t(MSG.START_OBSERVATION_TO_SEE_DEVICES)}</p> : (
        <div className="network-table-wrap">
          <table className="network-table">
            <thead>
              <tr>
                <th>{t(MSG.ADDRESS_AND_IDENTIFIER)}</th>
                <th>{t(MSG.SOURCES_AND_SERVICES)}</th>
                <th>MAC</th>
                <th>{t(MSG.PACKETS)}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(row => (
                <tr key={row.device_id || row.ip}>
                  <td>
                    <strong>{row.ip}</strong>
                    {row.hostname && <span>{row.hostname}</span>}
                    {row.device_id && <code>{row.device_id}</code>}
                    {row.version && <span className="help">Tuya {row.version}</span>}
                    {row.changes.length > 0 && (
                <details>
                  <summary>{t(MSG.IP_CHANGES) + " "}{row.changes.length}</summary>
                  {row.changes.map((change, index) => <p className="help" key={index}>{seen(change.at)} · {change.previous_ip} → {change.ip}</p>)}
                </details>
)}
                  </td>
                  <td>
                    <span>{row.protocols.map(protocol => protocols[protocol] || protocol).join(' · ')}</span>
                    {row.services.map(service => <code key={service}>{service}</code>)}
                    {!row.services.length && !row.device_id && <span className="help">{t(MSG.TYPE_NOT_YET_KNOWN)}</span>}
                  </td>
                  <td>
                    <code>{row.mac || '—'}</code>
                  </td>
                  <td>
                    <strong>{row.packets}</strong>
                    <span className="help">{seen(row.last_seen)}</span>
                    {!row.packets && <span className="help">{row.cached ? t(MSG.CACHED_TUYA_ANNOUNCEMENT) : t(MSG.NEIGHBOR_CACHE_ENTRY)}</span>}
                  </td>
                </tr>
))}
            </tbody>
          </table>
        </div>
  )}
      <details className="network-events">
        <summary>{t(MSG.PACKET_LOG) + " "}{data?.events.length || 0}</summary>
        <p className="help">{t(MSG.LAST_200_EVENTS_TIME_SENDER_PORT_AND_RECOGNIZED)}</p>
        {data?.events.length ? (
          <ol>
            {[...data.events].reverse().map((event, index) => (
              <li key={index}>
                <time>{seen(event.at)}</time>
                <code>{event.ip}:{event.port}</code>
                <span>{protocols[event.protocol] || event.protocol}</span>
                {event.device_id && <code>{event.device_id}</code>}
              </li>
))}
          </ol>
) :
          <p className="help">{t(MSG.NO_PACKETS_YET)}</p>}
      </details>
    </section>
  );
}
