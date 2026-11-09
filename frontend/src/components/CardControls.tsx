import { MSG, t } from "../i18n";
import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import type { CloudDevice, JsonValue, Provider } from '../api';
import {
  cloudBatchCommands, cloudReading, cloudSpecs, displayReading, isStale,
  localCommandValue, localReading, localSpec, validateControlValue, withChannelLabels,
} from '../controls';
import type { ControlSpec } from '../controls';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import type { DeviceState, HomeApi, Reading } from '../home-api';
import { readLocalDevice } from '../local-device-cache';
import { useAppDispatch, useAppSelector } from '../store';
import { cloudPendingScope, localPendingScope } from '../pending-device-values';
import { useLocalDeviceState } from '../use-local-device-state';
import { useCloudDeviceSnapshot } from '../use-cloud-device-snapshot';
import { cloudAccountScope } from '../cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, labelsFromCloudDefinitions, nextDeviceMetadataRevision } from '../device-metadata';
import { CapabilityField, ControlFeedback, useControlSession } from './DeviceControls';
import type { ControlNotice } from './DeviceControls';
import { batteryFromSpecs, DeviceIcon, isBattery, isCamera, ParameterIcon } from './DevicePresentation';
import type { BatteryReading } from './DevicePresentation';
import type { PowerSide } from './ControlRow';
import { ChannelControl, RelayChannel } from './ChannelControl';
import { CameraCardControls } from './CameraCardControls';
import { DashboardSheet } from './DashboardSheet';
import type { DashboardSheetState } from './DashboardSheet';
import { IconGlyph } from './ui/icon';
import useLightCardControls from './LightCardControls';
import { powerDisplayOverride, usePowerCardControls } from './PowerCardControls';
import type { MemberPower } from './PowerCardControls';

const CARD_CACHE_INTERVAL = 4000;
const SOCKET_METER_CODES = /^(?:add_ele|cur_(?:current|power|voltage)|electric(?:ity)?_coe|power_coe|voltage_coe|current|power|voltage|energy|electricity|fault)(?:_[1-9][0-9]*)?$/;
const DASHBOARD_SETTING_CODE = /^(?:(?:countdown|relay_status|switch_backlight)(?:_[1-9][0-9]*)?|switch_inching|do_not_disturb|remote_switch|work_mode|scene_data(?:_v2)?)$/;
const ELECTRICAL_UNIT = /^(?:mA|A|mV|V|mW|W|kW|Wh|kWh)$/i;

function sensorReading(spec: ControlSpec, socket: boolean) {
  return spec.readable && !spec.writable && !spec.advanced && !/^switch_mode/.test(spec.key) && !isBattery(spec.key)
    && !DASHBOARD_SETTING_CODE.test(spec.key)
    && (!socket || !(SOCKET_METER_CODES.test(spec.key) || ELECTRICAL_UNIT.test(spec.unit ?? '')))
    && ['number', 'boolean', 'enum', 'text'].includes(spec.kind);
}

export type CardStatus = {online:boolean;battery?:BatteryReading};

type QuickSheet = DashboardSheetState & {
  presetSlot?: HTMLDivElement | null;
  onLightFeatures?: (hasQuickSettings: boolean, hasPresets: boolean) => void;
};

type EmbeddedControls = {
  embeddedQuick?: boolean;
  powerSide?: PowerSide;
  inlineMemberName?: string;
  renderQuickTarget?: (content: ReactNode) => ReactNode;
  onPower?: (power: MemberPower) => void;
  channelChildren?: ReadonlyMap<string, ReactNode>;
  supplyPower?: false | null;
};

function unplacedChannelChildren(children?: ReadonlyMap<string, ReactNode>, channels: ControlSpec[] = []) {
  return children && Array.from(children, ([code, content]) => (
    channels.some(({ key }) => key === code) ? null : <Fragment key={code}>{content}</Fragment>
  ));
}

type CardProps = EmbeddedControls & {
  api: HomeApi;
  device: UnifiedDevice;
  displayName?: string;
  route: DeviceRoute;
  now: number;
  paused: boolean;
  loadWhenPaused?: boolean;
  previewOnly?: boolean;
  onAuthError: () => void;
  onBusy: (busy: boolean) => void;
  onStatus?: (status: CardStatus) => void;
  sheet?: QuickSheet;
};

// Only cards entering the viewport request missing metadata. Keep an activated
// card mounted when it scrolls away so the controls remain available.
export function CardControls(props: CardProps) {
  const container = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(false), [visible, setVisible] = useState(false);
  const {
    device, displayName, route, paused, embeddedQuick, sheet, loadWhenPaused, channelChildren, supplyPower, previewOnly,
  } = props;
  const sheetOpen = Boolean(sheet?.open && !paused);
  useEffect(() => { if (sheetOpen) setActivated(true); }, [sheetOpen]);
  useEffect(() => {
    if (!window.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      const inView = entries.some(entry => entry.isIntersecting);
      setVisible(inView);
      if (inView && !paused) setActivated(true);
    });
    const controls = container.current!;
    // Observe the card so visibility remains stable when its controls load or collapse.
    observer.observe(controls.closest('.dashboard-device') || controls);
    return () => observer.disconnect();
  }, [paused]);
  const cloud = route !== 'local' ? device.cloud[route] : undefined;
  const active = activated || route === 'local' || cloud?.controls?.ready || sheetOpen || embeddedQuick
    || loadWhenPaused || Boolean(channelChildren?.size) || supplyPower !== undefined || previewOnly;
  // Continue local checks so a confirmed reply can disprove the inferred cutoff.
  const pollingVisible = visible && !paused && (supplyPower !== false || route === 'local');
  let controls: ReactNode;
  if (!active) {
    controls = <button type="button" className="secondary compact full-width" disabled={paused} onClick={() => setActivated(true)}>{t(MSG.SHOW_STATE)}</button>;
  } else if (route === 'local') {
    controls = <LocalCardControls {...props} visible={pollingVisible} />;
  } else if (cloud) {
    controls = <CloudCardControls {...props} cloud={cloud} provider={route} visible={pollingVisible} />;
  }
  return (
    <div className="card-quick-controls tw:min-w-0 tw:empty:hidden" ref={container} role="group" aria-label={t(MSG.MAIN_CONTROLS_PREFIX) + (displayName ?? device.name)}>
      {controls}
    </div>
  );
}

function useCardCommands(execute: ReturnType<typeof useControlSession>['execute'], onBusy: (busy: boolean) => void,
  send: (spec: ControlSpec, value: JsonValue) => Promise<void>) {
  const [sending,setSending] = useState(false);
  useEffect(() => { onBusy(sending); return () => onBusy(false); },[sending,onBusy]);
  async function toggle(spec:ControlSpec,value:JsonValue) {
    if (sending) return false;
    setSending(true);
    try { return await execute(async () => {
      validateControlValue(spec,value);
      await send(spec,value);
      return {text:t(MSG.COMMAND_ACCEPTED_NOTICE)};
    }) === true; } finally { setSending(false); }
  }
  return { sending, toggle };
}

function StandardCardControls({
  api, tuyaApi, name, deviceId, pendingScope, paused, sheet, specs, reading, now, local, online, busy,
  readOK, sending, refresh, toggle, notice, category, onAuthError, embeddedQuick, onPower, channelChildren, powerSide, inlineMemberName, renderQuickTarget, supplyPower,
}: EmbeddedControls & {
  api: HomeApi; tuyaApi?: HomeApi; name: string; deviceId: string; pendingScope: string; paused: boolean; sheet?: QuickSheet; specs: ControlSpec[];
  reading: (spec: ControlSpec) => Reading | undefined; now: number; local: boolean; online: boolean; busy: boolean; readOK: boolean; sending: boolean;
  refresh: () => Promise<void>; toggle: (spec: ControlSpec, value: JsonValue) => Promise<boolean>; notice: ControlNotice;
  category?: string; onAuthError: () => void;
}) {
  const currentReading = (spec: ControlSpec | undefined) => {
    const value = spec && reading(spec);
    if (!online && value?.known) return value;
    return isStale(value, now, local) ? undefined : value;
  };
  const { powers, layout: powerLayout } = usePowerCardControls({
    specs,
    read: currentReading,
    online,
    supply: supplyPower,
    onPower,
  });
  const disabled = paused || busy || !readOK || sending || !online || supplyPower !== undefined;
  const lighting = useLightCardControls({
    api,
    tuyaApi,
    deviceId,
    specs,
    singlePower: powerLayout === 'single',
    currentReading,
    reading,
    now,
    local,
    disabled,
    send: toggle,
    scope: pendingScope,
    onAuthError,
    presetSlot: sheet?.presetSlot,
    onLightFeatures: sheet?.onLightFeatures,
  });
  const { summary } = lighting;
  const inlineName = inlineMemberName && powerLayout === 'single' && !channelChildren?.size;
  const renderSummary = inlineName || summary ? (power: boolean | null) => {
    const readings = summary?.(power);
    const powerLabel = power ? MSG.ON : MSG.OFF;
    const content = inlineName ? (
      <span className="combined-member-inline">
        <span className="combined-member-inline-name">{inlineMemberName}</span>
        {readings ?? <span className="combined-member-inline-state">{t(power === null ? MSG.NO_DATA : powerLabel)}</span>}
      </span>
    ) : readings;
    return renderQuickTarget?.(content) ?? content;
  } : undefined;
  const socket = category === 'cz' || specs.some(({ key }) => /^(?:add_ele|cur_(?:power|current|voltage))$/.test(key));
  const sensors = specs.filter((spec) => !lighting.isLightLevel(spec) && sensorReading(spec, socket));
  const unplaced = unplacedChannelChildren(channelChildren, powers);
  if (!busy && readOK && !powers.length && !sensors.length && !notice.error) return unplaced ?? null;
  const field = (spec: ControlSpec, headingActions?: ReactNode, showSummary = true) => {
    const reported = reading(spec);
    return (
      <CapabilityField
        pendingScope={pendingScope}
        headingActions={headingActions}
        key={spec.key}
        spec={spec}
        reading={reported}
        now={now}
        local={local}
        immediatePower
        dashboardSwitch
        powerSide={channelChildren?.has(spec.key) ? 'start' : powerSide}
        powerIcon={powerLayout === 'single' && !channelChildren?.has(spec.key)
          ? <DeviceIcon category={category} codes={specs.map((item) => item.key)} />
          : <ParameterIcon code={spec.key} />}
        powerSummary={showSummary ? renderSummary : undefined}
        displayPower={powerDisplayOverride(reported, online, supplyPower)}
        disabled={disabled}
        onSend={(value) => toggle(spec, value)}
        aliasEditor={spec.aliases?.length ? (
          <div className="capability-aliases">
            {spec.aliases.map((alias) => <span className="alias-tag" key={alias}>{alias}</span>)}
          </div>
        ) : undefined}
      />
    );
  };
  const sensorValues = sensors.length > 0 && (
  <div className="card-sensor-values tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-x-3 tw:gap-y-1.5">
    {sensors.map(spec => {
      const value = reading(spec), stale = !!value?.known && isStale(value,now,local);
      const label = spec.label + ': ' + displayReading(spec,value) + (stale ? t(MSG.STALE_SUFFIX) : '');
      return (
        <span key={spec.key} data-reading={spec.key} className={'card-sensor-value' + (stale || !value?.known ? ' unknown' : '')} title={label}>
          <ParameterIcon code={spec.key} />
          <span className="sr-only">{spec.label}: </span>
          <span>{displayReading(spec,value)}</span>
          {stale && <span className="sr-only">{t(MSG.STALE)}</span>}
        </span>
      );
    })}
  </div>
);
  const quickEditor = lighting.hasQuickSettings && (embeddedQuick || (sheet?.open && !paused)) && (
    <>
      {lighting.renderQuick(field(powers[0], undefined, false))}
      {notice.error && <ControlFeedback busy={false} notice={notice} />}
    </>
  );
  if (embeddedQuick && quickEditor) return quickEditor;
  return (
    <>
      {lighting.presetMenu}
      <div className="card-primary-controls tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-1" data-power-layout={powerLayout}>
        {powers.map((spec) => (channelChildren?.has(spec.key) ? (
          <RelayChannel key={spec.key} spec={spec} renderField={field}>
            {channelChildren.get(spec.key)}
          </RelayChannel>
        ) : <ChannelControl key={spec.key} spec={spec} renderField={field} />))}
        {!powerLayout && sensorValues}
        <button
          type="button"
          className="secondary card-refresh"
          aria-label={t(MSG.REFRESH_CONTROLS)}
          title={t(MSG.REFRESH_CONTROLS)}
          disabled={paused || busy || sending}
          onClick={() => void refresh()}
        >
          <IconGlyph name="refresh" />
        </button>
      </div>
      {powerLayout && sensorValues}
      {quickEditor && sheet && (
        <DashboardSheet title={name} onClose={sheet.close} returnFocus={sheet.trigger}>
          {quickEditor}
        </DashboardSheet>
      )}
      {((busy && (!powerLayout || !sending)) || notice.error) && <ControlFeedback busy={busy} notice={notice} />}
      {unplaced}
    </>
  );
}

function CloudCardControls({
  api, cloud, displayName, provider, now, visible, paused, sheet, onAuthError, onBusy, onStatus, embeddedQuick, onPower,
  channelChildren, powerSide, inlineMemberName, renderQuickTarget, supplyPower, previewOnly,
}: CardProps & { cloud: CloudDevice; provider: Provider; visible: boolean }) {
  const { snapshot, liveRequestAt, read } = useCloudDeviceSnapshot(api, cloud.id, provider);
  const dispatch = useAppDispatch();
  const labelKey = cloudMetadataKey(cloudAccountScope(api, provider), cloud.id);
  const labels = useAppSelector(state => state.deviceMetadata.channels[labelKey]?.value);
  const inventory = cloud.controls?.ready ? cloud.controls.definitions : undefined;
  const inventoryDefinitions = inventory?.device_id === cloud.id && Array.isArray(inventory.functions) ? inventory : undefined;
  const metadata = useMemo(() => ({
    definitions: inventoryDefinitions,
    seed: cloud.controls?.snapshot,
  }), [read]);
  useEffect(() => {
    // Developer inventory may omit functions after a refresh. Retain the last known labels.
    if (inventoryDefinitions) metadata.definitions = inventoryDefinitions;
  }, [inventoryDefinitions, metadata]);
  const load = useCallback(async (refresh:boolean,signal?:AbortSignal) => {
    const cached = metadata.definitions;
    const revision = cached ? 0 : nextDeviceMetadataRevision();
    const definitions = cached ?? await api.deviceFunctions(cloud.id,provider,signal);
    if (definitions.device_id !== cloud.id || !Array.isArray(definitions.functions)) throw new Error(t(MSG.THE_SERVICE_RETURNED_ANOTHER_DEVICES_CAPABILITIES));
    if (!signal?.aborted && !cached) {
      metadata.definitions ??= definitions;
      dispatch(cacheDeviceMetadata([{ key: labelKey, revision, channelLabels: labelsFromCloudDefinitions(definitions) }]));
    }
    await read(refresh, signal, metadata.seed);
    return metadata;
  },[api,cloud.id,provider,metadata,read,dispatch,labelKey]);
  const poll = useCallback(async (current:typeof metadata,signal:AbortSignal) => {
    await read(false, signal, undefined, true);
    return current;
  },[read]);
  const session = useControlSession(load, onAuthError, provider === 'sharing' && visible ? poll : undefined, CARD_CACHE_INTERVAL);
  const baseDefinitions = session.data === metadata ? inventoryDefinitions ?? metadata.definitions : undefined;
  const definitions = useMemo(() => baseDefinitions && labels ? withChannelLabels(baseDefinitions, labels) : baseDefinitions, [baseDefinitions, labels]);
  const specs = definitions && snapshot ? cloudSpecs(definitions,snapshot) : [];
  useEffect(() => {
    if (definitions && snapshot) onStatus?.({online:snapshot.online, battery:batteryFromSpecs(cloudSpecs(definitions,snapshot),snapshot.status)});
  },[definitions,snapshot,onStatus]);
  const commands = useCardCommands(session.execute, onBusy, async (spec, value) => {
    const result = await api.sendDeviceCommands(cloud.id, provider, cloudBatchCommands([{spec,value}], definitions!, snapshot!.status));
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
  });
  const reading = (spec: ControlSpec) => snapshot
    ? { ...cloudReading(spec, snapshot.status[spec.key], snapshot.status_observations?.[spec.key]), liveRequestAt }
    : undefined;
  const pendingScope = cloudPendingScope(api, provider, cloud.id);
  const controls = {name:displayName ?? cloud.name, pendingScope, paused, sheet, specs, reading, now, busy:session.busy, readOK:session.readOK && !!definitions && !!snapshot,
    refresh:session.refresh, notice:session.notice, ...commands};
  return isCamera(cloud.category)
    ? (
      <>
        <CameraCardControls {...controls} api={api} deviceId={cloud.id} provider={provider} onAuthError={onAuthError}
          online={snapshot?.online ?? cloud.online}
          paused={paused || supplyPower !== undefined}
          embeddedQuick={embeddedQuick}
          previewOnly={previewOnly}
        />
        {unplacedChannelChildren(channelChildren)}
      </>
)
    : (
      <StandardCardControls
        {...controls}
        api={api}
        tuyaApi={provider === 'sharing' ? api : undefined}
        deviceId={cloud.id}
        onAuthError={onAuthError}
        local={false}
        online={snapshot?.online ?? cloud.online}
        category={cloud.category}
        embeddedQuick={embeddedQuick}
        onPower={onPower}
        channelChildren={channelChildren}
        powerSide={powerSide}
        inlineMemberName={inlineMemberName}
        renderQuickTarget={renderQuickTarget}
        supplyPower={supplyPower}
      />
    );
}

function LocalCardControls({
  api, device, displayName, now, visible, paused, sheet, onAuthError, onBusy, embeddedQuick, onPower, channelChildren, powerSide, inlineMemberName, renderQuickTarget, supplyPower,
}: CardProps & { visible: boolean }) {
  const item = device.local!;
  const dispatch = useAppDispatch();
  const cached = useLocalDeviceState(api, item.id);
  const load = useCallback((refresh: boolean, signal?: AbortSignal) =>
    dispatch(readLocalDevice(api, item.id, refresh, signal)), [api, dispatch, item.id]);
  const poll = useCallback((_current: DeviceState, signal: AbortSignal) =>
    dispatch(readLocalDevice(api, item.id, false, signal, true)), [api, dispatch, item.id]);
  const session = useControlSession(load, onAuthError, visible ? poll : undefined, CARD_CACHE_INTERVAL);
  const state = cached ?? session.data;
  const specs = Object.entries(item.capabilities).map(([key,cap]) => localSpec(key,cap));
  const commands = useCardCommands(session.execute, onBusy, async (spec, value) => {
    const result = await api.setCapabilities(item.id, { [spec.key]: localCommandValue(spec, value) });
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
  });
  return (
    <StandardCardControls
      api={api}
      tuyaApi={device.cloud.sharing ? api : undefined}
      onAuthError={onAuthError}
      name={displayName ?? device.name}
      deviceId={device.id}
      pendingScope={localPendingScope(api, item.id)}
      paused={paused}
      sheet={sheet}
      specs={specs}
      category={device.cloud.sharing?.category || device.cloud.developer?.category}
      reading={(spec) => localReading(spec, state?.values[spec.key])}
      now={now}
      local
      online={!!state?.enabled && state.available}
      busy={session.busy}
      readOK={session.readOK && !!state?.enabled}
      refresh={session.refresh}
      notice={session.notice}
      embeddedQuick={embeddedQuick}
      onPower={onPower}
      channelChildren={channelChildren}
      powerSide={powerSide}
      inlineMemberName={inlineMemberName}
      renderQuickTarget={renderQuickTarget}
      supplyPower={supplyPower}
      {...commands}
    />
  );
}
