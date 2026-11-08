import {
  useCallback, useId, useRef, useState,
} from 'react';
import type {
  CombinedDevice, CombinedMember, CombinedPowerOutcome, HomeApi,
} from '../home-api';
import { useDeviceDisplayName } from '../devices';
import type { UnifiedDevice } from '../devices';
import { ApiError } from '../api';
import { cloudDeviceKey, readCloudDevice } from '../cloud-device-cache';
import { readLocalDevice } from '../local-device-cache';
import { MSG, t } from '../i18n';
import {
  selectCommandPending, setCommandPending, useAppDispatch, useAppSelector,
} from '../store';
import { CardControls } from './CardControls';
import type { MemberPower } from './CardControls';
import DashboardCardFooter from './DashboardCardFooter';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import type { GridCardPlacement } from './DashboardGrid';
import { DashboardSheet } from './DashboardSheet';
import { DeviceIcon, ParameterIcon } from './DevicePresentation';
import { PowerButton } from './PowerButton';
import { Card } from './ui/card';
import { Icon } from './ui/icon';

export type ResolvedMember = { member: CombinedMember; device?: UnifiedDevice };

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
  api, entry, now, paused, quick, onPower, onAuthError, commandKey,
}: {
  api: HomeApi;
  entry: ResolvedMember;
  now: number;
  paused: boolean;
  quick?: boolean;
  commandKey: string;
  onPower: (deviceId: string, power: MemberPower) => void;
  onAuthError: () => void;
}) {
  const { member, device } = entry;
  const id = member.device_id;
  const displayName = useDeviceDisplayName()(device, id);
  const dispatch = useAppDispatch();
  const recordBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: commandKey, pending }));
  }, [commandKey, dispatch]);
  const recordPower = useCallback((power: MemberPower) => onPower(id, power), [id, onPower]);
  return (
    <section className="combined-member" aria-label={displayName}>
      <h3 className="combined-member-name">{displayName}</h3>
      {device ? (
        <CardControls
          api={api}
          device={device}
          displayName={displayName}
          route={member.route}
          now={now}
          paused={paused}
          embeddedQuick={quick}
          onPower={quick ? undefined : recordPower}
          onBusy={recordBusy}
          onAuthError={onAuthError}
        />
      ) : <p className="combined-member-unavailable">{t(MSG.UNAVAILABLE)}</p>}
    </section>
  );
}

export default function CombinedDeviceCard({
  api, combined, members, room, now, placement, paused, quickOpen, onQuickOpen, onQuickClose, onDetails, onAuthError,
}: {
  api: HomeApi;
  combined: CombinedDevice;
  members: ResolvedMember[];
  room: string;
  now: number;
  placement: GridCardPlacement;
  paused: boolean;
  quickOpen: boolean;
  onQuickOpen: () => void;
  onQuickClose: () => void;
  onDetails: () => void;
  onAuthError: () => void;
}) {
  const id = `combined-${combined.id}`;
  const powerId = useId();
  const displayName = useDeviceDisplayName();
  const trigger = useRef<HTMLButtonElement>(null);
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
  const onPower = useCallback((deviceId: string, power: MemberPower) => {
    setPowers((values) => (values[deviceId] === power ? values : { ...values, [deviceId]: power }));
  }, []);
  const memberPowers = members.map(({ member, device }) => (device ? powers[member.device_id] ?? 'unknown' : 'unknown'));
  const power = aggregatePower(memberPowers);
  const knownPowers = memberPowers.filter((value) => value !== 'unknown');
  const allKnownOn = knownPowers.length > 0 && knownPowers.every((value) => value === 'on');
  const canSend = !busy && !paused && members.some(({ device }) => device);

  const setPower = useCallback(async (value: boolean) => {
    if (!canSend || sending.current) return;
    sending.current = true;
    setFailures({});
    setSendError(false);
    dispatch(setCommandPending({ deviceId: id, pending: true }));
    try {
      const { results } = await api.combinationPower(combined.id, value);
      setFailures(Object.fromEntries(results.flatMap(({ device_id: memberId, outcome }) => (
        outcome === 'accepted' ? [] : [[memberId, outcome]]
      ))));
      const refreshIds = new Set(results.filter(({ outcome }) => outcome === 'accepted' || outcome === 'unknown').map(({ device_id: memberId }) => memberId));
      // Acknowledgement and cached reports can arrive at different times for each member.
      const reads = members.filter(({ member, device }) => device && refreshIds.has(member.device_id)).map(({ member, device }) => {
        if (member.route === 'local') {
          return device?.local ? dispatch(readLocalDevice(api, device.local.id, true)) : undefined;
        }
        const key = cloudDeviceKey(api, member.device_id, member.route);
        return dispatch(readCloudDevice(api, key, { refresh: true }));
      });
      const refreshed = await Promise.allSettled(reads);
      if (refreshed.some((result) => result.status === 'rejected' && result.reason instanceof ApiError && result.reason.status === 401)) onAuthError();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setSendError(true);
    } finally {
      sending.current = false;
      dispatch(setCommandPending({ deviceId: id, pending: false }));
    }
  }, [api, canSend, combined.id, dispatch, id, members, onAuthError]);

  function renderMember(entry: ResolvedMember, quick = false) {
    const { member } = entry;
    return (
      <MemberControls
        key={`${member.device_id}:${member.route}`}
        api={api}
        entry={entry}
        now={now}
        paused={paused || aggregateBusy || (quickOpen && !quick)}
        quick={quick}
        commandKey={memberKey(member.device_id, quick)}
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
      data-layout-slot={placement.slot}
      data-layout-nudge={placement.nudge}
      style={placement.style}
      inert={placement.inert}
    >
      <DashboardCardHeader
        icon={<DeviceIcon group />}
        title={combined.name}
        metadata={(
          <>
            <p className="device-location">{room}</p>
            <p className="device-location">{t(MSG.COMBINED_MEMBER_COUNT, [members.length])} · {t(powerLabels[power])}</p>
          </>
        )}
        actions={(
          <>
            <PowerButton
              id={powerId}
              label={t(MSG.COMBINED_POWER)}
              checked={allKnownOn}
              disabled={!canSend}
              variant="button"
              icon={<ParameterIcon code="switch" />}
              known
              onChange={setPower}
            />
            <button
              className="secondary tile-icon-action"
              type="button"
              ref={trigger}
              aria-label={t(MSG.QUICK_DEVICE_CONTROLS)}
              title={t(MSG.QUICK_DEVICE_CONTROLS)}
              aria-haspopup="dialog"
              aria-expanded={quickOpen}
              disabled={busy || paused}
              onClick={onQuickOpen}
            >
              <Icon name="sliders" />
            </button>
            <CardDetailsButton label={t(MSG.DETAILS)} disabled={busy || paused} onClick={onDetails} />
          </>
        )}
      />
      <DashboardCardFooter>
        {members.map((entry) => renderMember(entry))}
        {(sendError || Object.keys(failures).length > 0) && <div className="combined-actions">{feedback}</div>}
      </DashboardCardFooter>
      {quickOpen && (
        <DashboardSheet title={combined.name} onClose={onQuickClose} returnFocus={trigger} busy={busy}>
          {members.map((entry) => renderMember(entry, true))}
        </DashboardSheet>
      )}
    </Card>
  );
}
