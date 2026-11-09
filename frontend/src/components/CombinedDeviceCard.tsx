import {
  Fragment, useCallback, useId, useRef, useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { shallowEqual } from 'react-redux';
import type {
  CombinedDevice, CombinedPowerOutcome, HomeApi,
} from '../home-api';
import { useDeviceDisplayName } from '../devices';
import { ApiError } from '../api';
import { labelFor } from '../controls';
import combinedLayout from '../combined-layout';
import {
  memberOnline, refreshCombinedMember, useLocalSupplyEvidence, useRestoredWiring, wiredSupply,
} from '../combined-power';
import type { ResolvedMember } from '../combined-power';
import { MSG, t } from '../i18n';
import {
  selectCommandPending, setCommandPending, useAppDispatch, useAppSelector,
} from '../store';
import { CardControls } from './CardControls';
import type { MemberPower } from './PowerCardControls';
import ControlRow from './ControlRow';
import type { PowerSide } from './ControlRow';
import DashboardCardFooter from './DashboardCardFooter';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import type { GridCardPlacement } from './DashboardGrid';
import { DashboardSheet } from './DashboardSheet';
import { DeviceIcon, ParameterIcon } from './DevicePresentation';
import { PowerButton } from './PowerButton';
import { Card } from './ui/card';
import { Icon } from './ui/icon';

export type { ResolvedMember } from '../combined-power';

function aggregatePower(powers: MemberPower[]): MemberPower {
  if (powers.includes('unknown')) return 'unknown';
  if (powers.every((value) => value === 'on')) return 'on';
  if (powers.every((value) => value === 'off')) return 'off';
  return 'mixed';
}

const powerLabels = {
  on: MSG.ON,
  off: MSG.OFF,
  mixed: MSG.COMBINED_MIXED_POWER,
  unknown: MSG.STATUS_UNKNOWN,
};

type PowerFailure = Exclude<CombinedPowerOutcome, 'accepted'>;

const outcomeLabels: Record<PowerFailure, keyof typeof MSG> = {
  unavailable: MSG.UNAVAILABLE,
  unsupported: MSG.COMBINED_NO_POWER_CONTROL,
  unknown: MSG.COMBINED_OUTCOME_UNKNOWN,
};

function MemberControls({
  api, entry, now, paused, preview, quick, onPower, onAuthError, commandKey, sourceLabel, channelChildren, powerSide, depth, supplyPower, onOpen,
}: {
  api: HomeApi;
  entry: ResolvedMember;
  now: number;
  paused: boolean;
  preview: boolean;
  depth: number;
  quick?: boolean;
  commandKey: string;
  sourceLabel?: string;
  channelChildren?: ReadonlyMap<string, ReactNode>;
  powerSide?: PowerSide;
  supplyPower?: false | null;
  onOpen?: (button: HTMLButtonElement) => void;
  onPower: (deviceId: string, power: MemberPower) => void;
  onAuthError: () => void;
}) {
  const { member, device } = entry;
  const id = member.device_id;
  const displayName = useDeviceDisplayName()(device, id);
  const dispatch = useAppDispatch();
  const online = useAppSelector((state) => memberOnline(state, api, entry));
  const recordBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: commandKey, pending }));
  }, [commandKey, dispatch]);
  const recordPower = useCallback((power: MemberPower) => onPower(id, power), [id, onPower]);
  const memberName = onOpen ? (
    <button
      className="combined-member-quick-button"
      type="button"
      aria-haspopup="dialog"
      disabled={paused}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {displayName}
    </button>
  ) : displayName;
  return (
    <section
      className="combined-member"
      aria-label={displayName}
      data-unavailable={!device || online === false || supplyPower !== undefined || undefined}
      style={depth ? { '--combined-depth': depth } as CSSProperties : undefined}
    >
      <header className="combined-member-header">
        <h3 className="combined-member-name">{memberName}</h3>
        {sourceLabel && <p className="combined-member-source">{sourceLabel}</p>}
      </header>
      {device ? (
        <CardControls
          api={api}
          device={device}
          displayName={displayName}
          route={member.route}
          now={now}
          paused={paused}
          loadWhenPaused={preview}
          embeddedQuick={quick}
          onPower={quick ? undefined : recordPower}
          onBusy={recordBusy}
          onAuthError={onAuthError}
          channelChildren={channelChildren}
          powerSide={powerSide}
          inlineMemberName={sourceLabel && !quick ? memberName : undefined}
          supplyPower={supplyPower}
        />
      ) : (
        <>
          <p className="combined-member-unavailable">{t(MSG.UNAVAILABLE)}</p>
          {channelChildren && Array.from(channelChildren, ([code, content]) => <Fragment key={code}>{content}</Fragment>)}
        </>
      )}
    </section>
  );
}

const noAction = () => undefined;

export default function CombinedDeviceCard({
  api, combined, members, room, now, placement, paused = false, quickOpen = false, quickMemberId, onMemberQuickOpen,
  onQuickOpen = noAction, onQuickClose = noAction, onDetails = noAction, onAuthError,
}: {
  api: HomeApi;
  combined: Pick<CombinedDevice, 'name' | 'show_all_power' | 'aliases'> & Partial<Pick<CombinedDevice, 'id'>>;
  members: ResolvedMember[];
  room: string;
  now: number;
  placement?: GridCardPlacement;
  paused?: boolean;
  quickOpen?: boolean;
  quickMemberId?: string;
  onMemberQuickOpen?: (deviceId: string) => void;
  onQuickOpen?: () => void;
  onQuickClose?: () => void;
  onDetails?: () => void;
  onAuthError: () => void;
}) {
  const powerId = useId();
  const { id: savedId } = combined;
  const preview = savedId === undefined;
  const id = preview ? `combined-preview-${powerId}` : `combined-${savedId}`;
  const displayName = useDeviceDisplayName();
  const trigger = useRef<HTMLButtonElement>(null);
  const memberTrigger = useRef<HTMLButtonElement>(null);
  const dispatch = useAppDispatch();
  const sending = useRef(false);
  const memberKey = (memberId: string, quick = false) => `${id}:${memberId}:${quick}`;
  const aggregateBusy = useAppSelector((state) => selectCommandPending(state, id));
  const memberBusy = useAppSelector((state) => members.some(({ member }) => (
    selectCommandPending(state, memberKey(member.device_id)) || selectCommandPending(state, memberKey(member.device_id, true))
  )));
  const busy = aggregateBusy || memberBusy;
  const [powers, setPowers] = useState<Record<string, MemberPower>>({});
  const [failures, setFailures] = useState<Partial<Record<string, PowerFailure>>>({});
  const [sendError, setSendError] = useState(false);
  const layout = combinedLayout(members);
  const supplies = useAppSelector((state) => wiredSupply(state, api, layout, now), shallowEqual);
  const reachableWithRelayOff = useLocalSupplyEvidence(api, members, supplies, now);
  const waiting = useRestoredWiring(api, members, supplies, paused || preview, onAuthError);
  const allOffline = useAppSelector((state) => members.length > 0 && members.every((entry) => !entry.device || memberOnline(state, api, entry) === false));

  function suppliedPower(deviceId: string) {
    if (supplies[deviceId] === false && !reachableWithRelayOff.includes(deviceId)) return false;
    if (supplies[deviceId] === true && waiting.has(deviceId)) return null;
    return undefined;
  }

  const onPower = useCallback((deviceId: string, power: MemberPower) => {
    setPowers((values) => (values[deviceId] === power ? values : { ...values, [deviceId]: power }));
  }, []);
  const memberPowers = members.map(({ member, device }) => {
    const supplied = suppliedPower(member.device_id);
    if (supplied === false) return 'off';
    if (!device || supplied === null) return 'unknown';
    return powers[member.device_id] ?? 'unknown';
  });
  const power = aggregatePower(memberPowers);
  const knownPowers = memberPowers.filter((value) => value !== 'unknown');
  const allKnownOn = knownPowers.length > 0 && knownPowers.every((value) => value === 'on');
  const controlsPaused = paused || preview;
  const canSend = !busy && !controlsPaused && !allOffline && members.some(({ device }) => device);

  const setPower = useCallback(async (value: boolean) => {
    if (savedId === undefined || !canSend || sending.current) return;
    sending.current = true;
    setFailures({});
    setSendError(false);
    dispatch(setCommandPending({ deviceId: id, pending: true }));
    try {
      const { results } = await api.combinationPower(savedId, value);
      setFailures(Object.fromEntries(results.flatMap(({ device_id: memberId, outcome }) => (
        outcome === 'accepted' ? [] : [[memberId, outcome]]
      ))));
      const refreshIds = new Set(results.filter(({ outcome }) => outcome === 'accepted' || outcome === 'unknown').map(({ device_id: memberId }) => memberId));
      // Acknowledgement and cached reports can arrive at different times for each member.
      const reads = members.filter(({ member, device }) => device && refreshIds.has(member.device_id))
        .map((entry) => refreshCombinedMember(dispatch, api, entry));
      const refreshed = await Promise.allSettled(reads);
      if (refreshed.some((result) => result.status === 'rejected' && result.reason instanceof ApiError && result.reason.status === 401)) onAuthError();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setSendError(true);
    } finally {
      sending.current = false;
      dispatch(setCommandPending({ deviceId: id, pending: false }));
    }
  }, [api, canSend, dispatch, id, members, onAuthError, savedId]);

  const quickMember = quickMemberId ? layout.byId.get(quickMemberId) : undefined;

  function renderMember(entry: ResolvedMember, quick = false, depth = 0): ReactNode {
    const { member } = entry;
    const source = member.power_source;
    const relay = source && layout.byId.get(source.device_id);
    const sourceLabel = source && t(MSG.COMBINED_SUPPLIED_BY, [displayName(relay?.device, source.device_id), labelFor(source.channel)]);
    const channels = quick ? undefined : layout.channels.get(member.device_id);
    const channelChildren = channels && new Map(Array.from(channels, ([code, entries]) => [
      code,
      entries.map((child) => renderMember(child, false, depth + 1)),
    ]));
    const open = !quick && !preview && entry.device && onMemberQuickOpen
      ? (button: HTMLButtonElement) => {
        memberTrigger.current = button;
        onMemberQuickOpen(member.device_id);
      } : undefined;
    return (
      <MemberControls
        key={`${member.device_id}:${member.route}`}
        api={api}
        entry={entry}
        now={now}
        paused={controlsPaused || aggregateBusy || (quickOpen && !quick)}
        preview={preview}
        depth={depth}
        quick={quick}
        commandKey={memberKey(member.device_id, quick)}
        sourceLabel={sourceLabel || undefined}
        powerSide={!quick && source ? 'start' : undefined}
        supplyPower={suppliedPower(member.device_id)}
        channelChildren={channelChildren}
        onOpen={open}
        onPower={onPower}
        onAuthError={onAuthError}
      />
    );
  }

  const feedback = (
    <>
      {sendError && <p className="field-error" role="alert">{t(MSG.COMBINED_OUTCOME_UNKNOWN)}</p>}
      {Object.keys(failures).length > 0 && (
        <ul className="combined-results" aria-live="polite">
          {members.map(({ member, device }) => {
            const outcome = failures[member.device_id];
            return outcome && <li key={member.device_id}>{displayName(device, member.device_id)} · {t(outcomeLabels[outcome])}</li>;
          })}
        </ul>
      )}
    </>
  );

  return (
    <Card
      id={id}
      className="device-card dashboard-device combined-device-card"
      aria-label={combined.name}
      data-unavailable={allOffline || undefined}
      data-layout-slot={placement?.slot}
      data-layout-nudge={placement?.nudge}
      style={placement?.style}
      inert={placement?.inert}
    >
      <DashboardCardHeader
        icon={<DeviceIcon group />}
        title={combined.name}
        aliases={combined.aliases}
        metadata={(
          <>
            <p className="device-location">{room}</p>
            <p className="device-location">{t(MSG.COMBINED_MEMBER_COUNT, [members.length])} · {t(powerLabels[power])}</p>
          </>
        )}
        actions={(
          <>
            <button
              className="secondary tile-icon-action"
              type="button"
              ref={trigger}
              aria-label={t(MSG.QUICK_DEVICE_CONTROLS)}
              title={t(MSG.QUICK_DEVICE_CONTROLS)}
              aria-haspopup="dialog"
              aria-expanded={quickOpen}
              disabled={busy || controlsPaused}
              onClick={onQuickOpen}
            >
              <Icon name="sliders" />
            </button>
            <CardDetailsButton label={t(MSG.DETAILS)} disabled={busy || controlsPaused} onClick={onDetails} />
          </>
        )}
      />
      <DashboardCardFooter>
        {layout.roots.map((entry) => renderMember(entry))}
        {(sendError || Object.keys(failures).length > 0) && <div className="combined-actions">{feedback}</div>}
        {combined.show_all_power !== false && (
          <div className="combined-power-footer" data-power-layout="single">
            <div className="capability-boolean">
              <ControlRow
                heading={<h3 className="capability-heading">{t(MSG.COMBINED_POWER)}</h3>}
                state={<span className="dashboard-power-state">{t(powerLabels[power])}</span>}
                power={(
                  <div className="power-actions">
                    <PowerButton
                      id={powerId}
                      label={t(MSG.COMBINED_POWER)}
                      checked={allKnownOn}
                      disabled={!canSend}
                      variant="dashboard-switch"
                      icon={<ParameterIcon code="switch" />}
                      known
                      onChange={setPower}
                    />
                  </div>
                )}
              />
            </div>
          </div>
        )}
      </DashboardCardFooter>
      {quickOpen && (
        <DashboardSheet
          title={quickMember ? displayName(quickMember.device, quickMember.member.device_id) : combined.name}
          onClose={onQuickClose}
          returnFocus={quickMember ? memberTrigger : trigger}
          busy={busy}
        >
          {(quickMember ? [quickMember] : members).map((entry) => renderMember(entry, true))}
        </DashboardSheet>
      )}
    </Card>
  );
}
