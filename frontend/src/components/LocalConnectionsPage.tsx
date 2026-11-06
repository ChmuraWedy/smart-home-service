import { MSG, localizeMessages, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api';
import type { CloudDevice, LanDevice, NetworkInterface, NetworkScan, Provider } from '../api';
import type { ConnectionFinding, HomeApi, Inventory, LocalDevice } from '../home-api';
import { deviceHref } from '../device-links';

type Stage = 'start' | 'search' | 'choose' | 'verify' | 'confirm' | 'save' | 'done';
type Candidate = { device: CloudDevice; observed: LanDevice[]; configured: boolean };
type Checked = { candidate: Candidate; finding?: ConnectionFinding; expiresAt?: number; error?: string };
type Outcome = { id: string; name: string; message: string; saved: boolean; connectionId?: string };
const actions = localizeMessages({ created: MSG.WILL_BE_ADDED, updated: MSG.WILL_BE_UPDATED, unchanged: MSG.NO_CHANGES });
const savedActions = localizeMessages({ created: MSG.CONNECTION_SAVED, updated: MSG.CONNECTION_UPDATED, unchanged: MSG.VERIFIED_NO_CHANGES });
const changes = localizeMessages({ ip: MSG.IP_ADDRESS, version: MSG.PROTOCOL_VERSION, local_key: MSG.LOCAL_KEY_INLINE });
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
const message = (failure: unknown) => failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_REQUEST);

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
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
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
  const selectAll = useRef<HTMLInputElement>(null);
  const allSelected = candidates.length > 0 && candidates.slice(0, MAX_SELECTION).every(row => selected.includes(row.device.id));
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allSelected; }, [selected, allSelected, stage]);

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
    setOutcomes([]); setError(''); setProgress('');
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
        if (!Array.isArray(rows) || !Array.isArray(networks)) throw new Error(t(MSG.COULD_NOT_READ_DEVICES_AND_NETWORKS));
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
      setError(t(MSG.SEARCH_STOPPED_BECAUSE_THE_TAB_IS_HIDDEN));
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
        if (row.scan_id !== id || row.interface?.address !== address || !Array.isArray(row.devices)) throw new Error(t(MSG.THE_OBSERVATION_BELONGS_TO_A_DIFFERENT_NETWORK));
      };
      validate(snapshot);
      const readyBy = Date.now() + 2000;
      while (!snapshot.ports.includes(7000) && Date.now() < readyBy) {
        await pause(250, controller.signal); snapshot = await api.networkScan(id, controller.signal); validate(snapshot);
      }
      if (!snapshot.ports.includes(7000)) throw new Error(t(MSG.CHECK_TUYA_ANNOUNCEMENT_PORT));
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
      if (snapshot.failed_ports.length) setError(t(MSG.SOME_PORTS_ARE_UNAVAILABLE));
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
        setProgress(t(MSG.CHECKING) + (results.length + 1) + t(MSG.OF_SEPARATOR) + selected.length + ': ' + candidate.device.name);
        try {
          const finding = await api.findLocalConnection(candidate.device.id, provider, address, controller.signal, 3);
          if (controller.signal.aborted) return;
          if (finding.verified !== true || finding.requested_device_id !== candidate.device.id || finding.interface_address !== address ||
              finding.connection_device_id !== finding.device.device_id || !finding.finding_id || !Object.hasOwn(actions, finding.action) ||
              !['direct', 'gateway'].includes(finding.route) || (finding.route === 'direct' && finding.connection_device_id !== candidate.device.id) ||
              !Array.isArray(finding.device.changed_fields) || !Array.isArray(finding.device.aliases) ||
              !Number.isFinite(finding.expires_in) || finding.expires_in <= 0) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_UNEXPECTED_RESULT));
          if (results.some(row => row.finding?.connection_device_id === finding.connection_device_id)) throw new Error(t(MSG.THIS_CONNECTION_IS_ALREADY_SHOWN_FOR_ANOTHER_SELECTED));
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
        setProgress(t(MSG.SAVING) + finding.device.name);
        if (row.expiresAt! <= Date.now()) {
          results.push({ id: row.candidate.device.id, name: finding.device.name, message: t(MSG.VERIFICATION_EXPIRED), saved: false }); continue;
        }
        try {
          const result = await api.saveLocalConnection(finding.finding_id);
          if (!mounted.current) break;
          setInventory(current => current ? { ...current, devices: [...current.devices.filter(item => item.device_id !== result.device.device_id), result.device] } : current);
          results.push({ id: row.candidate.device.id, connectionId: result.device.device_id, name: result.device.name, message: savedActions[result.action], saved: true });
        } catch (failure) {
          if (!mounted.current) break;
          results.push({ id: row.candidate.device.id, name: finding.device.name, message: failure instanceof ApiError ? failure.message : t(MSG.NO_RESPONSE_RECEIVED), saved: false });
          if (failure instanceof ApiError && failure.status === 401) { callbacks.current.onAuthError(); break; }
          // An ambiguous write is never automatically retried.
        }
      }
      if (mounted.current) { setOutcomes(results); setChecked([]); setConfirmed(false); setStage('done'); }
    } finally { busy.current = false; callbacks.current.onLock(false); }
  }
  const step = stage === 'start' || stage === 'search' ? 0 : stage === 'choose' || stage === 'verify' ? 1 : stage === 'confirm' || stage === 'save' ? 2 : 3;
  return (
    <section className="card local-connections-page" aria-labelledby="local-connections-heading">
      <p className="eyebrow">{t(MSG.HOME_NETWORK)}</p>
      <h1 id="local-connections-heading">{t(MSG.LOCAL_CONNECTIONS)}</h1>
      <ol className="connection-steps" aria-label={t(MSG.SETUP_STEPS)}>
        {[t(MSG.NETWORK), t(MSG.DISCOVERED_DEVICES), t(MSG.CONFIRMATION), t(MSG.RESULT)].map((label, index) => (
          <li key={label} aria-current={step === index ? 'step' : undefined}>
            <span>{index + 1}</span>{label}
          </li>
))}
      </ol>
      {stage !== 'start' && <p className="help">{t(MSG.NETWORK_LABEL) + " "}{interfaces.find(row => row.address === address)?.network}{" " + t(MSG.SERVER_IP) + " "}{address}</p>}
      {!sharingReady && !developerReady && (
      <div className="saved-summary">{t(MSG.CONNECT_A_TUYA_ACCOUNT_FIRST) + " "}
        <button className="secondary" onClick={onConnections}>{t(MSG.OPEN_CONNECTIONS)}</button>
      </div>
)}
      {stage === 'start' && (
      <>
        <h2>{t(MSG.WHERE_SHOULD_WE_LOOK_FOR_DEVICES)}</h2>
        <p className="muted">{t(MSG.COLLECT_ANNOUNCEMENTS_ON_THE_SELECTED_NETWORK_FOR_15)}</p>
        <div className="local-connection-form connection-network-form">
          <label>{t(MSG.ACCOUNT)}
            <select value={provider} disabled={!ready || loading || (!sharingReady && !developerReady)} onChange={event => setProvider(event.target.value as Provider)}>
              <option value="sharing" disabled={!sharingReady}>Smart Life / QR</option>
              <option value="developer" disabled={!developerReady}>Tuya Developer</option>
            </select>
          </label>
          <label>{t(MSG.DEVICE_NETWORK)}
            <select value={address} disabled={!connected || loading} onChange={event => setAddress(event.target.value)}>
              <option value="">{t(MSG.SELECT_A_NETWORK)}</option>
              {interfaces.map(row => <option key={row.address} value={row.address}>{row.name} · {row.network} · IP {row.address}</option>)}
            </select>
          </label>
        </div>
        <label className="local-connection-confirm">
          <input type="checkbox" checked={includeConfigured} disabled={!connected || loading} onChange={event => setIncludeConfigured(event.target.checked)} />{t(MSG.INCLUDE_CONFIGURED_DEVICES_FOR_RECONFIGURATION)}
        </label>
        <p className="help">{includeConfigured ? t(MSG.SEARCH_ALL_ACCOUNT_DEVICES_INCLUDING_CONFIGURED_ONES) : t(MSG.SEARCH_ONLY_DEVICES_WITHOUT_A_CONFIGURED_LOCAL_CONNECTION)}{connected && !loading && t(MSG.NEED_SETUP) + pending.length + t(MSG.CONFIGURED) + (devices.length - pending.length)}</p>
        <div className="local-connection-actions">
          <button disabled={!connected || loading || !address} onClick={() => void search()}>{t(MSG.FIND_DEVICES)}</button>
          <button className="secondary" disabled={!connected || loading} onClick={() => setRevision(value => value + 1)}>{t(MSG.REFRESH_LISTS)}</button>
        </div>
        {connected && !loading && !interfaces.length && <p className="help">{t(MSG.NO_PRIVATE_IPV4_NETWORKS_FOUND)}</p>}
      </>
)}
      {working && (
      <div className="connection-progress" role="status">
        <span className="spinner" aria-hidden="true" />
        <strong>{stage === 'search' ? t(MSG.SEARCHING_FOR_DEVICES_REMAINING) + seconds + t(MSG.SECONDS_SUFFIX) : progress}</strong>
        <p className="help">{stage === 'search' ? t(MSG.RECEIVING_ANNOUNCEMENTS_ONLY_ON_THE_SELECTED_NETWORK) : stage === 'verify' ? t(MSG.VERIFY_KEYS_BY_READING_STATUS) : t(MSG.EACH_CONFIRMED_CONNECTION_IS_SAVED_SEPARATELY)}</p>
        {stage !== 'save' && <button className="secondary" onClick={() => { stop(); setChecked([]); setStage(stage === 'search' ? 'start' : 'choose'); }}>{t(MSG.CANCEL)}</button>}
      </div>
)}
      {stage === 'choose' && (
      <>
        <h2>{t(MSG.DEVICES_FOUND) + " "}{candidates.length}</h2>
        <p className="help">{t(MSG.SELECT_CONNECTIONS_TO_VERIFY) + " "}{MAX_SELECTION}{" " + t(MSG.DEVICES_AT_A_TIME)}</p>
        {!candidates.length && <p className="saved-summary">{t(MSG.NO_MATCHING_DEVICES_FOUND_ON_THIS_NETWORK)}</p>}
        {candidates.length > 0 && (
        <div className="connection-table-wrap">
          <table className="connection-device-table" aria-label={t(MSG.DISCOVERED_DEVICES)}>
            <thead>
              <tr>
                <th scope="col">
              <input ref={selectAll} type="checkbox" aria-label={candidates.length > MAX_SELECTION ? t(MSG.SELECT_FIRST_16_DEVICES) : t(MSG.SELECT_ALL_DEVICES)} checked={allSelected} onChange={event => setSelected(event.target.checked ? candidates.slice(0, MAX_SELECTION).map(row => row.device.id) : [])} />
            </th>
                <th scope="col">{t(MSG.DEVICE)}</th>
                <th scope="col">{t(MSG.IP_ADDRESS)}</th>
                <th scope="col">{t(MSG.CONNECTION)}</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map(row => (
                <tr key={row.device.id}>
              <td>
              <input type="checkbox" aria-label={t(MSG.SELECT) + row.device.name} checked={selected.includes(row.device.id)} disabled={!selected.includes(row.device.id) && selected.length >= MAX_SELECTION} onChange={event => setSelected(current => event.target.checked ? [...current, row.device.id] : current.filter(id => id !== row.device.id))} />
            </td>
              <td>
              <strong>{row.device.name}</strong>
              {row.device.aliases?.length ? <small>{row.device.aliases.join(' · ')}</small> : null}
            </td>
              <td>{row.observed.map(item => item.ip).join(', ')}</td>
              <td>{row.configured ? t(MSG.ALREADY_CONFIGURED) : t(MSG.NOT_CONFIGURED_LOCALLY)}</td>
            </tr>
))}
            </tbody>
          </table>
        </div>
)}
        {candidates.length > 0 && <p className="help">{t(MSG.SELECTED) + " "}{selected.length}{" " + t(MSG.OF) + " "}{candidates.length}{candidates.length > MAX_SELECTION ? t(MSG.THE_HEADER_CHECKBOX_SELECTS_THE_FIRST_16_DEVICES) : ''}</p>}
        {excluded > 0 && <p className="help">{t(MSG.CONFIGURED_DEVICES_SKIPPED) + " "}{excluded}{t(MSG.TO_INCLUDE_THEM_CHANGE_THE_CHECKBOX_ON_THE)}</p>}
        {unknown > 0 && <p className="help">{t(MSG.TUYA_ANNOUNCEMENTS_OUTSIDE_THE_SELECTED_ACCOUNT) + " "}{unknown}{t(MSG.THESE_ARE_NOT_OFFERED_FOR_CONFIGURATION)}</p>}
        <div className="local-connection-actions">
          <button disabled={!selected.length} onClick={() => void verify()}>{t(MSG.VERIFY_SELECTED)}</button>
          <button className="secondary" onClick={startOver}>{t(MSG.BACK_TO_NETWORK_SELECTION)}</button>
          <button className="secondary" onClick={() => { setOutcomes([]); setStage('done'); }}>{t(MSG.FINISH_WITHOUT_SAVING)}</button>
        </div>
      </>
)}
      {stage === 'confirm' && (
      <>
        <h2>{t(MSG.CONFIRM_SAVING)}</h2>
        <p className="help">{t(MSG.CHECK_NAMES_ADDRESSES_AND_CHANGES)}</p>
        {checked.map(row => (
          <section className="local-connection-preview" key={row.candidate.device.id}>
            <h3>{row.finding?.device.name || row.candidate.device.name}</h3>
            {row.finding ? (
              <>
                <p>
                  <strong>{actions[row.finding.action]}</strong>{" " + t(MSG.CONNECTION_VERIFIED_BADGE)}
                </p>
                {row.finding.route === 'gateway' && <p className="help">{t(MSG.SELECTED) + " "}{row.candidate.device.name}{t(MSG.THE_GATEWAY_IS_BEING_SAVED_THIS_DOES_NOT)}</p>}
                <dl className="local-connection-facts">
                  <div>
                <dt>{t(MSG.DEVICE_IP)}</dt>
                <dd>{row.finding.device.ip}</dd>
              </div>
                  <div>
                <dt>{t(MSG.TUYA_PROTOCOL)}</dt>
                <dd>{row.finding.device.version}</dd>
              </div>
                  <div>
                <dt>{t(MSG.CONNECTION)}</dt>
                <dd>{row.finding.device.is_gateway ? t(MSG.TUYA_GATEWAY_TYPE) : t(MSG.WIFI_DEVICE_TYPE)}</dd>
              </div>
                  <div>
                <dt>{t(MSG.BUILDING)}</dt>
                <dd>{inventory?.buildings.find(building => building.id === row.finding!.device.building_id)?.name || t(MSG.NOT_ASSIGNED)}</dd>
              </div>
                  <div>
                <dt>{t(MSG.ROOM)}</dt>
                <dd>{inventory?.rooms.find(room => room.id === row.finding!.device.room_id)?.name || t(MSG.NOT_ASSIGNED_FEMININE)}</dd>
              </div>
                  <div>
                <dt>{t(MSG.KEY)}</dt>
                <dd>{t(MSG.VERIFIED) + " "}{row.finding.key_source === 'device' ? t(MSG.FROM_THIS_DEVICES_DATA) : t(MSG.FROM_A_GATEWAY_CHILD_DEVICES_DATA)}</dd>
              </div>
                </dl>
                {row.finding.device.aliases.length > 0 && <p className="help">{row.finding.device.aliases.join(' · ')}</p>}
                {row.finding.action === 'updated' && <p className="help">{t(MSG.CHANGES) + " "}{row.finding.device.changed_fields.map(key => changes[key]).join(', ')}{t(MSG.NAME_ALIASES_ROOM_AND_FUNCTIONS_ARE_PRESERVED)}</p>}
                {row.finding.action === 'created' && <p className="help">{t(MSG.A_CONNECTION_WILL_BE_CREATED_WITH_THE_SHOWN)}</p>}
                <p className="help">{row.expiresAt! > now ? t(MSG.RESULT_VALID_FOR_ANOTHER) + Math.ceil((row.expiresAt! - now) / 1000) + t(MSG.SECONDS_SUFFIX) : t(MSG.THE_RESULT_EXPIRED)}</p>
              </>
) :
              <p className="field-error">{row.error}</p>}
          </section>
))}
        <label className="local-connection-confirm">
          <input type="checkbox" checked={confirmed} disabled={!valid.length || expired} onChange={event => setConfirmed(event.target.checked)} />{t(MSG.I_CONFIRM_SAVING_THESE_CONNECTIONS)}{valid.length})
        </label>
        <div className="local-connection-actions">
          <button disabled={!confirmed || !valid.length || expired} onClick={() => void save()}>{t(MSG.SAVE_CONNECTIONS)}</button>
          <button className="secondary" onClick={() => { setChecked([]); setConfirmed(false); setStage('choose'); }}>{t(MSG.CHANGE_SELECTION)}</button>
          <button className="secondary" onClick={() => { setOutcomes(checked.filter(row => row.error).map(row => ({ id: row.candidate.device.id, name: row.candidate.device.name, message: row.error!, saved: false }))); setChecked([]); setConfirmed(false); setStage('done'); }}>{t(MSG.FINISH_WITHOUT_SAVING)}</button>
        </div>
      </>
)}
      {stage === 'done' && (
      <>
        <h2>{t(MSG.SETUP_RESULTS)}</h2>
        {outcomes.length ? (
          <ul className="connection-results">
            {outcomes.map(row => (
              <li key={row.id}>
                {row.saved && row.connectionId ? <Link to={deviceHref(row.connectionId, 'local')}>{row.name}</Link> :
                <strong>{row.name}</strong>}
                <span className={row.saved ? 'online' : 'field-error'}>{row.message}</span>
              </li>
))}
          </ul>
) :
          <p className="help">{t(MSG.NO_CONNECTIONS_WERE_SAVED)}</p>}
        <h3>{t(MSG.STILL_UNCONFIGURED) + " "}{pending.length}</h3>
        <p className="help">{t(MSG.THESE_ACCOUNT_DEVICES_LACK_COMPLETE_LOCAL_CONNECTIONS)}</p>
        <ul className="connection-results">
          {pending.map(device => (
            <li key={device.id}>
              <strong>{device.name}</strong>
              {device.aliases?.length ? <span>{device.aliases.join(' · ')}</span> : null}
            </li>
))}
        </ul>
        {!pending.length && <p className="help">{t(MSG.ALL_DEVICES_HAVE_LOCAL_CONNECTIONS)}</p>}
        <div className="local-connection-actions">
          <button onClick={() => { startOver(); setRevision(value => value + 1); }}>{t(MSG.NEW_SEARCH)}</button>
        </div>
      </>
)}
      {error && <p role="alert" className="field-error">{translateText(error)}</p>}
      {!working && (
      <details className="network-explanation">
        <summary>{t(MSG.HOW_DISCOVERY_WORKS)}</summary>
        <p>{t(MSG.ONLY_ANNOUNCEMENTS_WITH_AN_EXACT_DEVICE_ID_IN)}</p>
        <p>{t(MSG.AFTER_SELECTION_THE_SERVER_DISCOVERS_THE_ADDRESS_AGAIN)}</p>
      </details>
)}
    </section>
  );
}
