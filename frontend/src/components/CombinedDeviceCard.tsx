import { useCallback, useRef, useState } from 'react';
import type {
  CombinedDevice, CombinedMember, CombinedPowerOutcome, HomeApi,
} from '../home-api';
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
import { DeviceIcon } from './DevicePresentation';
import { Card } from './ui/card';

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

const outcomeLabels: Record<CombinedPowerOutcome, keyof typeof MSG> = {
  accepted: MSG.COMMAND_ACCEPTED_NOTICE,
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
  const dispatch = useAppDispatch();
  const recordBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: commandKey, pending }));
  }, [commandKey, dispatch]);
  const recordPower = useCallback((power: MemberPower) => onPower(id, power), [id, onPower]);
  return (
    <section className="combined-member" aria-label={device?.name ?? id}>
      <h3 className="combined-member-name">{device?.name ?? id}</h3>
      {device ? (
        <CardControls
          api={api}
          device={device}
          route={member.route}
          now={now}
          paused={paused}
          embeddedQuick={quick}
          onPower={recordPower}
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
  const [outcomes, setOutcomes] = useState<Record<string, CombinedPowerOutcome>>({});
  const [sendError, setSendError] = useState(false);
  const onPower = useCallback((deviceId: string, power: MemberPower) => {
    setPowers((values) => (values[deviceId] === power ? values : { ...values, [deviceId]: power }));
  }, []);
  const power = aggregatePower(members.map(({ member, device }) => (device ? powers[member.device_id] ?? 'unknown' : 'unknown')));
  const canSend = !busy && !paused && members.some(({ device }) => device);

  async function setPower(value: boolean) {
    if (!canSend || sending.current) return;
    sending.current = true;
    setOutcomes({});
    setSendError(false);
    dispatch(setCommandPending({ deviceId: id, pending: true }));
    try {
      const { results } = await api.combinationPower(combined.id, value);
      setOutcomes(Object.fromEntries(results.map((result) => [result.device_id, result.outcome])));
      const reads = members.filter(({ device }) => device).map(({ member, device }) => {
        if (member.route === 'local') {
          return device?.local ? dispatch(readLocalDevice(api, device.local.id, false, undefined, true)) : undefined;
        }
        const key = cloudDeviceKey(api, member.device_id, member.route);
        return dispatch(readCloudDevice(api, key, { refresh: member.route === 'developer', watch: true }));
      });
      await Promise.allSettled(reads);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setSendError(true);
    } finally {
      sending.current = false;
      dispatch(setCommandPending({ deviceId: id, pending: false }));
    }
  }

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

  const groupPower = (
    <div className="combined-power" role="group" aria-label={t(MSG.COMBINED_POWER)}>
      <button className="secondary compact" type="button" disabled={!canSend} onClick={() => setPower(true)}>{t(MSG.ALL_ON)}</button>
      <button className="secondary compact" type="button" disabled={!canSend} onClick={() => setPower(false)}>{t(MSG.ALL_OFF)}</button>
    </div>
  );
  const feedback = (
    <>
      {sendError && <p className="field-error" role="alert">{t(MSG.COMBINED_OUTCOME_UNKNOWN)}</p>}
      {Object.keys(outcomes).length > 0 && (
        <ul className="combined-results" aria-live="polite">
          {members.map(({ member, device }) => {
            const outcome = outcomes[member.device_id];
            return outcome && <li key={member.device_id}>{device?.name ?? member.device_id} · {t(outcomeLabels[outcome])}</li>;
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
        actions={<CardDetailsButton label={t(MSG.DETAILS)} disabled={busy || paused} onClick={onDetails} />}
      />
      <DashboardCardFooter>
        {members.map((entry) => renderMember(entry))}
        <div className="combined-actions">
          {groupPower}
          <button
            className="secondary compact"
            type="button"
            ref={trigger}
            aria-haspopup="dialog"
            aria-expanded={quickOpen}
            disabled={busy || paused}
            onClick={onQuickOpen}
          >
            {t(MSG.QUICK_DEVICE_CONTROLS)}
          </button>
          {!quickOpen && feedback}
        </div>
      </DashboardCardFooter>
      {quickOpen && (
        <DashboardSheet title={combined.name} onClose={onQuickClose} returnFocus={trigger} busy={busy}>
          {groupPower}
          {feedback}
          {members.map((entry) => renderMember(entry, true))}
        </DashboardSheet>
      )}
    </Card>
  );
}
