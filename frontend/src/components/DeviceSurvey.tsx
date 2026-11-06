import { MSG, dateLocale, localizeMessages, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudDevice, JsonValue, Provider } from '../api';
import { labelFor } from '../controls';
import { HomeApi } from '../home-api';
import type { DeviceDraft, Inventory, ObservationAction, ObservationReading, ObservationSession, Placement, LocalDevice } from '../home-api';

const actions: Record<ObservationAction, { label: string; prompt: string }> = localizeMessages({
  observe: { label: MSG.OBSERVATION, prompt: MSG.READ_THE_INITIAL_STATE_THEN_SELECT_THE_ACTION },
  power: { label: MSG.POWER_ON_AND_OFF, prompt: MSG.TURN_THE_DEVICE_ON_USING_ITS_PHYSICAL_BUTTON },
  brightness: { label: MSG.BRIGHTNESS, prompt: MSG.CHANGE_BRIGHTNESS_IN_SMART_LIFE_WAIT_FOR_A },
  temperature: { label: MSG.COLOR_TEMPERATURE, prompt: MSG.CHOOSE_WARM_AND_THEN_COOL_LIGHT_IN_SMART },
  color: { label: MSG.COLOR, prompt: MSG.CHOOSE_TWO_DIFFERENT_COLORS_IN_SMART_LIFE },
  sensor: { label: MSG.SENSOR, prompt: MSG.TRIGGER_AN_EVENT_SUCH_AS_MOTION_OPENING_OR },
  button: { label: MSG.BUTTON_OR_REMOTE, prompt: MSG.PRESS_THE_BUTTON_WAIT_FOR_A_REPORT_THEN },
});
const textValue = (value: JsonValue) => value === true ? t(MSG.ON_YES) : value === false ? t(MSG.OFF_NO) : value === null ? t(MSG.NO_VALUE) : typeof value === 'object' ? JSON.stringify(value) : String(value);
const title = (row: ObservationReading) => row.code ? labelFor(row.code) : t(MSG.PARAMETER) + (row.dp ? 'DP ' + row.dp : row.key);
const timeLabel = (stamp: string | null) => stamp ? new Date(stamp).toLocaleString(dateLocale()) : t(MSG.REPORT_TIME_NOT_PROVIDED);

export function DeviceSurvey({ api, inventory, device, provider, placement, cloudDevices = [], gatewayPlacements = [], gatewayOnly = false, onSaved, onClose, onAuthError, existing }: {
  api: HomeApi; inventory: Inventory; device?: CloudDevice; provider?: Provider;
  placement?: Placement; cloudDevices?: CloudDevice[]; gatewayPlacements?: Placement[];
  gatewayOnly?: boolean; onSaved?: (device: LocalDevice) => void;
  existing?: LocalDevice;
  onClose: () => void; onAuthError: () => void;
}) {
  const [step, setStep] = useState<'configure' | 'observe'>('configure');
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
  const writable = observation?.readings.filter(row => row.can_write).map(row => row.key) || [];
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
    setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_POLL_THE_DEVICE));
    if (failure instanceof ApiError && failure.status === 401) onAuthError();
  }

  useEffect(() => {
    if (!sessionId || step !== 'observe' || gatewayProof || busy || paused || hidden || expired) { setPolling(false); return; }
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const interval = (observation?.interval_seconds || 5) * 1000;
    async function poll() {
      setPolling(true);
      try {
        const result = await api.observationSample(sessionId!, actionRef.current, controller.signal);
        if (stopped) return;
        if (result.session_id !== sessionId || result.device_id !== id) throw new Error(t(MSG.THE_SERVICE_RETURNED_A_DIFFERENT_DEVICE));
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
  }, [api, sessionId, step, gatewayProof, busy, paused, hidden, expired]);

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
      setExpired(false); setPaused(false); setStep('observe');
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
    if (!observation || busy || polling || expired || !name.trim() || (!gatewayProof && !observation.readings.length)) return;
    setPaused(true); setBusy(true); setError('');
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
    <label>{t(MSG.NAME)}<input value={name} maxLength={120} onChange={event => setName(event.target.value)} required /></label>
    <label>{t(MSG.COMMA_SEPARATED_ALIASES)}<input aria-label={t(MSG.COMMA_SEPARATED_ALIASES)} value={aliases} onChange={event => setAliases(event.target.value)} placeholder="kitchen_light, main_light" /><span className="help">{t(MSG.USE_LATIN_LETTERS_DIGITS)}</span></label>
    <label>{t(MSG.BUILDING)}<select value={building} onChange={event => { setBuilding(event.target.value); setRoom(''); }}><option value="">{t(MSG.NOT_SELECTED)}</option>{inventory.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>{t(MSG.ROOM)}<select value={room} onChange={event => setRoom(event.target.value)}><option value="">{t(MSG.NOT_SELECTED_FEMININE)}</option>{rooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  </div>;

  if (gatewaySetup) return <DeviceSurvey api={api} inventory={availableInventory} device={gatewaySetup.device} provider={gatewaySetup.device ? provider : undefined} gatewayOnly
    placement={gatewayPlacements.find(item => item.device_id === gatewaySetup.device?.id)}
    onAuthError={onAuthError} onClose={() => setGatewaySetup(null)} onSaved={saved => {
      setSavedGateways(current => [...current.filter(item => item.id !== saved.id), saved]);
      setParent(String(saved.id)); setGatewaySetup(null);
    }} />;

  return <section className="card device-survey" aria-labelledby="survey-heading">
    <div className="card-heading"><div><p className="eyebrow">{existing ? t(MSG.DEVICE_FUNCTIONS) : t(MSG.LOCAL_CONNECTION)} · {step === 'configure' ? '1 / 2' : '2 / 2'}</p><h2 id="survey-heading">{step === 'configure' ? existing ? t(MSG.SET_UP_DEVICE_FUNCTIONS) : t(MSG.SET_UP_LOCAL_CONNECTION) : t(MSG.CHECK_THE_DEVICE)}</h2></div><button className="secondary compact" disabled={busy} onClick={onClose}>{t(MSG.CANCEL)}</button></div>
    {step === 'configure' ? <form onSubmit={event => { event.preventDefault(); void begin(); }}>
      {existing ? <div className="saved-summary"><strong>{existing.name}</strong><p>{t(MSG.READ_THE_ACTUAL_LOCAL_PARAMETERS_AND_MATCH_THEM)}</p>{!provider && <p className="help">{t(MSG.TUYA_ACCOUNT_UNAVAILABLE_PARAMETERS_CAN_BE_SAVED_AS)}</p>}</div> : <><p className="help">{t(MSG.OPTIONAL_SETUP_FOR_CONTROL_OVER_YOUR_HOME_NETWORK)}</p>
      {device && <p className="help">{t(MSG.THIS_DEVICE_IS_ALREADY_AVAILABLE_THROUGH_SMART_LIFE)}</p>}
      {placement && <p className="help">{t(MSG.BUILDING_AND_ROOM_COME_FROM_SMART_LIFE)}</p>}
      {placementFields}
      <div className="survey-form-grid">
        <label>Tuya device ID<input value={id} readOnly={Boolean(device)} required maxLength={128} onChange={event => setId(event.target.value)} /></label>
        <label>{t(MSG.DEVICE_CONNECTION)}<select value={kind} disabled={fixedGateway} onChange={event => setKind(event.target.value)}>{fixedGateway ? <option value="gateway">{t(MSG.TUYA_GATEWAY)}</option> : <><option value="wifi">{t(MSG.WIFI_DEVICE)}</option><option value="gateway">{t(MSG.TUYA_GATEWAY)}</option><option value="zigbee">{t(MSG.ZIGBEE_THROUGH_GATEWAY)}</option></>}</select></label>
        {kind === 'zigbee' ? <><label>{t(MSG.GATEWAY)}<select value={parent} onChange={event => setParent(event.target.value)}><option value="">{gateways.length || cloudGateways.length ? t(MSG.SELECT_A_GATEWAY) : t(MSG.NO_CONFIGURED_GATEWAYS)}</option>{gateways.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{!item.enabled && t(MSG.DISABLED)}</option>)}{cloudGateways.map(item => <option key={item.id} value={'cloud:' + item.id}>{item.name}{" " + t(MSG.LOCAL_SETUP_REQUIRED)}</option>)}</select></label><label>cid / node_id<input value={cid} maxLength={128} onChange={event => setCid(event.target.value)} /></label></> : <><label>{t(MSG.HOME_NETWORK_IP)}<input value={ip} onChange={event => { setIp(event.target.value); setConfirmedIp(false); }} placeholder="192.168.1.40" /></label><label>{t(MSG.LOCAL_PROTOCOL_VERSION)}<select value={version} onChange={event => setVersion(event.target.value)}>{['3.1', '3.2', '3.3', '3.4', '3.5'].map(value => <option key={value}>{value}</option>)}</select></label>{device?.has_local_key ? <p className="saved-summary">{t(MSG.A_LOCAL_KEY_IS_AVAILABLE_ON_THE_SERVER)}</p> : <label>{t(MSG.LOCAL_KEY)}<input type="password" autoComplete="off" value={key} maxLength={16} onChange={event => setKey(event.target.value)} /><span className="help">{t(MSG.TEXT_16_CHARACTERS)}</span></label>}</>}
        <label>{t(MSG.READING_SOURCE)}<select value={mode} onChange={event => setMode(event.target.value as 'local' | 'cloud')}><option value="local">{t(MSG.LOCAL_POLLING_TUYA_LABELS)}</option>{provider && !gatewayOnly && <option value="cloud">{t(MSG.TUYA_CLOUD_REPORTS)}</option>}</select></label>
      </div>
      {kind === 'zigbee' && <div className="saved-summary">
        {selectedCloudGateway ? <><p>«{selectedCloudGateway.name}{t(MSG.WAS_FOUND_IN_SMART_LIFE)}</p><p className="help">{t(MSG.SELECT_THE_GATEWAY_THIS_SENSOR_IS_ACTUALLY_CONNECTED)}</p><button type="button" className="secondary compact" onClick={() => setGatewaySetup({ device: selectedCloudGateway })}>{t(MSG.SET_UP_SELECTED_GATEWAY)}</button></> : !gateways.length ? <p>{cloudGateways.length ? t(MSG.SELECT_A_GATEWAY_FROM_SMART_LIFE_AND_SET) : t(MSG.NO_GATEWAYS_WERE_FOUND_IN_THIS_SMART_LIFE)}{" " + t(MSG.THIS_WIZARD_IS_NOT_NEEDED_FOR_ORDINARY_SMART)}</p> : null}
        <button type="button" className="secondary compact" onClick={() => setGatewaySetup({})}>{t(MSG.SET_UP_ANOTHER_GATEWAY_MANUALLY)}</button>
      </div>}
      {gatewayOnly && <p className="help">{t(MSG.SETTING_UP_THE_GATEWAY)}</p>}
      {mode === 'cloud' && <p className="saved-summary">{t(MSG.CLOUD_REPORTS_MAY_BE_DELAYED)}</p>}
      {canDiscover && <div className="saved-summary">
        <p>{t(MSG.IF_THE_GATEWAY_KEY_IS_MISSING_CHECK_CHILD)}</p>
        <p className="help">{t(MSG.ENTER_THIS_GATEWAYS_IP_FROM_YOUR_ROUTERS_CLIENT)}</p>
        <label className="survey-checkbox"><input type="checkbox" checked={confirmedIp} onChange={event => setConfirmedIp(event.target.checked)} />{t(MSG.I_VERIFIED_THE_GATEWAY_IP_IN_THE_ROUTER)}</label>
        <button type="button" className="secondary" disabled={busy || !confirmedIp || !ip.trim() || !name.trim() || !['3.3', '3.4', '3.5'].includes(version)} onClick={() => void begin(true)}>{t(MSG.FIND_KEY_AND_VERIFY_GATEWAY)}</button>
      </div>}
      </>}
      <button disabled={busy || !name.trim() || !id.trim() || !childReady || (mode === 'local' && !localReady)}>{t(MSG.START_POLLING)}</button>
    </form> : <>
      {gatewayProof ? <div className="saved-summary"><strong>{t(MSG.SECURE_GATEWAY_CONNECTION_VERIFIED)}</strong><p>{gatewayProof.ip}{" " + t(MSG.PROTOCOL) + " "}{gatewayProof.version}</p><p>{gatewayProof.key_source === 'child' ? t(MSG.A_KEY_FROM_A_SMART_LIFE_CHILD_DEVICES) : t(MSG.THE_GATEWAYS_SMART_LIFE_KEY_WAS_VERIFIED)}{" " + t(MSG.THE_KEY_IS_NOT_DISPLAYED_IN_THE_BROWSER)}</p><p className="help">{t(MSG.A_GATEWAY_MAY_HAVE_NO_READINGS_OF_ITS)}</p></div> : <p className="help">{name} · {observation?.mode === 'local' ? t(MSG.ON_YOUR_HOME_NETWORK) : t(MSG.OVER_THE_INTERNET)}{" " + t(MSG.SAMPLES_RECEIVED) + " "}{observation?.sample_count || 0}</p>}
      {!gatewayProof && <>
        <div className="survey-prompt"><label>{t(MSG.ACTION_TO_CHECK)}<select value={action} onChange={event => setAction(event.target.value as ObservationAction)}>{Object.entries(actions).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label><p>{actions[action].prompt}</p><p className="help">{t(MSG.SELECTING_AN_ACTION_LABELS_OBSERVED_CHANGES_IT_DOES)}</p></div>
        <div className="survey-toolbar"><span role="status">{expired ? t(MSG.POLLING_STOPPED) : hidden ? t(MSG.POLLING_IS_PAUSED_WHILE_THIS_TAB_IS_HIDDEN) : paused ? t(MSG.POLLING_PAUSED) : polling ? t(MSG.READING_STATUS) : t(MSG.WAITING_FOR_THE_NEXT_SAMPLE)}</span><button className="secondary compact" disabled={expired} onClick={() => setPaused(value => !value)}>{paused ? t(MSG.RESUME) : t(MSG.PAUSED)}</button></div>
        <p className="help">{t(MSG.THE_SERVICE_READS_ONLY_THE_SELECTED_DEVICE_EVERY) + " "}{observation?.interval_seconds}{" " + t(MSG.SECONDS)}</p>
      </>}
      {!gatewayProof && <><p className="help">{t(MSG.SAVING_ENABLES_ALL_VERIFIED_FUNCTIONS)}</p>{observation?.mode === 'cloud' && <p className="help">{t(MSG.CLOUD_VALUES_ARE_NOT_SAVED_AS_LOCAL_STATE)}</p>}</>}
      {!gatewayProof && <><div className="survey-readings"><h3>{t(MSG.LATEST_READINGS)}</h3>{!observation?.readings.length ? <p className="empty-state">{t(MSG.NO_READINGS_YET)}</p> : <ul>{observation.readings.map(row => <li key={row.key}><div><strong>{title(row)}</strong><span className="help">{row.dp ? 'DP ' + row.dp : t(MSG.DP_NUMBER_UNKNOWN)}{row.code && ' · ' + row.code} · {timeLabel(row.received_at)}</span></div><output>{textValue(row.value)}</output></li>)}</ul>}</div>
      <div className="survey-history"><h3>{t(MSG.OBSERVED_CHANGES) + " "}<span className="count">{observation?.changes.length || 0}</span></h3>{!observation?.changes.length ? <p className="help">{t(MSG.NO_CHANGES_YET)}</p> : <ol>{[...observation.changes].reverse().map((row, index) => <li key={index}><span className="help">{timeLabel(row.detected_at)} · {actions[row.action as ObservationAction]?.label || t(MSG.OBSERVATION)}</span><strong>{title(row)}</strong><span>{textValue(row.previous)} → {textValue(row.value)}</span></li>)}</ol>}</div>
      </>}<div className="survey-footer"><button className="secondary" disabled={busy || polling} onClick={() => void restart()}>{existing ? t(MSG.START_AGAIN) : t(MSG.CHANGE_CONNECTION)}</button><button disabled={busy || polling || expired || !name.trim() || (!gatewayProof && !observation?.readings.length)} onClick={() => void save()}>{existing ? t(MSG.SAVE_FUNCTIONS) : t(MSG.SAVE_LOCAL_CONNECTION)}</button></div>
    </>}
    {busy && <p role="status" className="help">{step === 'configure' && canDiscover ? t(MSG.CHECKING_CONNECTION_THIS_MAY_TAKE_ABOUT_30_SECONDS) : t(MSG.PROCESSING_REQUEST)}</p>}{error && <p role="alert" className="field-error">{translateText(error)}</p>}
  </section>;
}
