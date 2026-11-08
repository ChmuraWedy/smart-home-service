import {
  useCallback, useEffect, useId, useRef, useState,
} from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import {
  deviceRoutes, matchesDevice, useDeviceDisplayName,
} from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import type {
  CombinedDevice, CombinedMemberInput, CombinedPowerSource, HomeApi, Room,
} from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { ControlDialog } from './DeviceControls';
import CombinedDeviceCard from './CombinedDeviceCard';
import type { ResolvedMember } from './CombinedDeviceCard';
import CombinedDeviceOrder from './CombinedDeviceOrder';
import CombinedDeviceWiring from './CombinedDeviceWiring';
import { Switch } from './ui/switch';

const creationSteps = [
  ['devices', MSG.COMBINED_SELECT_DEVICES],
  ['details', MSG.COMBINED_NAME_AND_ROOM],
  ['preview', MSG.COMBINED_CARD_PREVIEW],
] as const;
const editingSteps = [
  ['details', MSG.EDIT],
  ['preview', MSG.COMBINED_CARD_PREVIEW],
] as const;

export function CombinedDeviceDetails({
  combined, members, onChoose, onEdit, onClose,
}: {
  combined: CombinedDevice;
  members: ResolvedMember[];
  onChoose: (device: UnifiedDevice, route: DeviceRoute) => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const displayName = useDeviceDisplayName();
  return (
    <ControlDialog title={combined.name} busy={false} onClose={onClose}>
      <p>{t(MSG.CHOOSE_COMBINED_MEMBER)}</p>
      <ul className="combined-device-options">
        {members.map(({ member, device }) => (
          <li key={member.device_id}>
            <button
              type="button"
              className="secondary"
              disabled={!device}
              onClick={() => device && onChoose(device, member.route)}
            >
              {displayName(device, member.device_id)}
              {!device && ` · ${t(MSG.UNAVAILABLE)}`}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={onEdit}>{t(MSG.EDIT_COMBINATION)}</button>
    </ControlDialog>
  );
}

export function CombinedDeviceList({
  combinations, rooms, canCreate, onCreate, onEdit,
}: {
  combinations: CombinedDevice[];
  rooms: Room[];
  canCreate: boolean;
  onCreate: () => void;
  onEdit: (id: number) => void;
}) {
  return (
    <>
      <div className="card-heading">
        <div>
          <h1>{t(MSG.COMBINED_DEVICES)}</h1>
          <p className="help">{t(MSG.COMBINED_DEVICES_HELP)}</p>
        </div>
        <button type="button" disabled={!canCreate} onClick={onCreate}>{t(MSG.CREATE_COMBINED_DEVICE)}</button>
      </div>
      {combinations.length ? (
        <ul className="group-members">
          {combinations.map((item) => (
            <li key={item.id}>
              <div>
                <h2>{item.name}</h2>
                <p className="help">
                  {rooms.find(({ id }) => id === item.room_id)?.name ?? t(MSG.NO_ROOM)}
                  {' · '}
                  {t(MSG.COMBINED_MEMBER_COUNT, [item.members.length])}
                </p>
              </div>
              <button type="button" className="secondary compact" aria-label={`${t(MSG.EDIT)} ${item.name}`} onClick={() => onEdit(item.id)}>
                {t(MSG.EDIT)}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="saved-summary">{t(MSG.NO_COMBINED_DEVICES)}</p>}
    </>
  );
}

export function CombinedDeviceSettings({
  api, existing, devices, rooms, initialRoom, deviceRoom, now, cardSize, previewing, onPreview, onPreviewBack, onClose, onSaved, onAuthError,
}: {
  api: HomeApi;
  existing?: CombinedDevice;
  devices: UnifiedDevice[];
  rooms: Room[];
  initialRoom: number | null;
  deviceRoom: (device: UnifiedDevice) => number | null;
  now: number;
  cardSize: 'small' | 'large';
  previewing: boolean;
  onPreview: () => void;
  onPreviewBack: () => void;
  onClose: () => void;
  onSaved: (saved?: CombinedDevice) => void;
  onAuthError: () => void;
}) {
  const formId = useId();
  const displayName = useDeviceDisplayName();
  const [nameDraft, setName] = useState(existing?.name);
  const [showAllPower, setShowAllPower] = useState(existing?.show_all_power ?? true);
  const [draftStep, setDraftStep] = useState<'devices' | 'details'>(existing ? 'details' : 'devices');
  const step = previewing ? 'preview' : draftStep;
  const activeStep = useRef<HTMLLIElement>(null);
  useEffect(() => { activeStep.current?.focus(); }, [step]);
  const missingDraft = previewing && draftStep === 'devices';
  useEffect(() => { if (missingDraft) onPreviewBack(); }, [missingDraft, onPreviewBack]);
  const [chosenRoom, setRoom] = useState(existing ? existing.room_id : initialRoom ?? undefined);
  const [members, setMembers] = useState<CombinedMemberInput[]>(() => existing?.members.map(({ device_id: id, route, power_source: source }) => ({
    device_id: id, route, ...(source ? { power_source: source } : {}),
  })) ?? []);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [search, setSearch] = useState('');
  const byId = new Map(devices.map((device) => [device.id, device]));
  const selected = new Map(members.map((member) => [member.device_id, member]));
  const memberRooms = new Set(members.map(({ device_id: id }) => {
    const device = byId.get(id);
    return device ? deviceRoom(device) : null;
  }));
  const suggestedRoom = memberRooms.size === 1 ? [...memberRooms][0] : null;
  const room = chosenRoom === undefined ? suggestedRoom : chosenRoom;
  const roomName = rooms.find(({ id }) => id === room)?.name;
  const name = nameDraft ?? (roomName ? t(MSG.COMBINED_SUGGESTED_NAME, [roomName]).slice(0, 120) : '');
  const pickingDevices = step === 'devices';
  const steps = existing ? editingSteps : creationSteps;
  const submitLabel = existing ? MSG.COMBINED_CARD_PREVIEW : MSG.NEXT;
  const canSubmit = !busy && members.length >= 2 && (pickingDevices || Boolean(roomName && name.trim()));
  const options = [...new Set([...selected.keys(), ...devices.map((device) => device.id)])].filter((id) => {
    const device = byId.get(id);
    return selected.has(id) || (device && matchesDevice(device, search));
  });

  function handleFailure(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) onAuthError();
    else setError(failure instanceof Error ? failure.message : t(MSG.COMBINED_SAVE_FAILED));
  }

  function previewMember(member: CombinedMemberInput): ResolvedMember {
    const { device_id: id, route } = member;
    const device = byId.get(id);
    const saved = existing?.members.find((row) => row.device_id === id && row.route === route);
    const accessible = saved?.accessible !== false && device && deviceRoutes(device).includes(route);
    return { member, device: accessible ? device : undefined };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setError('');
    if (!previewing) {
      setConfirmDelete(false);
      if (pickingDevices) setDraftStep('details');
      else onPreview();
      return;
    }
    setBusy(true);
    try {
      const saved = await api.saveCombination({
        name: name.trim(), room_id: room, members, show_all_power: showAllPower,
      }, existing?.id);
      if (active.current) onSaved(saved);
    } catch (failure) {
      if (active.current) handleFailure(failure);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.removeCombination(existing.id);
      if (active.current) onSaved();
    } catch (failure) {
      if (active.current) handleFailure(failure);
    } finally {
      setBusy(false);
    }
  }

  function toggleMember(id: string, route: DeviceRoute | undefined, checked: boolean) {
    if (checked && route) {
      setMembers((rows) => [...rows, { device_id: id, route }]);
    } else {
      setMembers((rows) => rows.filter((member) => member.device_id !== id).map((member) => (
        member.power_source?.device_id === id ? { ...member, power_source: null } : member
      )));
    }
  }

  const selectSource = useCallback((id: string, source: CombinedPowerSource | null) => {
    setMembers((rows) => rows.map((member) => (member.device_id === id ? { ...member, power_source: source } : member)));
  }, []);

  const moveMember = useCallback((id: string, neighbor: string) => {
    setMembers((rows) => {
      const from = rows.findIndex((member) => member.device_id === id);
      const to = rows.findIndex((member) => member.device_id === neighbor);
      if (from < 0 || to < 0) return rows;
      const next = [...rows];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, []);

  if (missingDraft) return null;
  const previewMembers = previewing ? members.map(previewMember) : [];

  return (
    <>
      <h1>{t(existing ? MSG.EDIT_COMBINATION : MSG.CREATE_COMBINED_DEVICE)}</h1>
      <p className="help">{t(MSG.COMBINED_DEVICES_HELP)}</p>
      <form className="combined-device-form" aria-label={t(existing ? MSG.EDIT_COMBINATION : MSG.CREATE_COMBINED_DEVICE)} aria-busy={busy} onSubmit={(event) => save(event)}>
        <ol className="combined-creation-steps">
          {steps.map(([key, label]) => (
            <li key={key} ref={step === key ? activeStep : undefined} tabIndex={-1} aria-current={step === key ? 'step' : undefined}>
              {t(label)}
            </li>
          ))}
        </ol>
        {!previewing && Boolean(existing || pickingDevices) && (
          <>
            <label className="field" htmlFor={`${formId}-search`}>
              {t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}
              <input id={`${formId}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <fieldset className="combined-members" disabled={busy}>
              <legend>{t(MSG.CHOOSE_COMBINED_DEVICES)}</legend>
              {options.map((id) => {
                const device = byId.get(id);
                const choice = selected.get(id);
                const route = device ? deviceRoutes(device)[0] : undefined;
                const label = displayName(device, id);
                return (
                  <label className="combined-member-option" htmlFor={`${formId}-member-${id}`} key={id}>
                    <input
                      id={`${formId}-member-${id}`}
                      type="checkbox"
                      checked={Boolean(choice)}
                      disabled={!choice && (members.length >= 16 || !route)}
                      onChange={(event) => toggleMember(id, route, event.target.checked)}
                    />
                    {label}
                  </label>
                );
              })}
            </fieldset>
          </>
        )}
        {!existing && step === 'details' && <p className="help">{t(MSG.COMBINED_MEMBER_COUNT, [members.length])}</p>}
        {step === 'details' && (
          <>
            <label className="field" htmlFor={`${formId}-name`}>
              {t(MSG.NAME)}
              <input
                id={`${formId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
                disabled={busy}
              />
            </label>
            <label className="field" htmlFor={`${formId}-room`}>
              {t(MSG.ROOM)}
              <select
                id={`${formId}-room`}
                value={room ?? ''}
                onChange={(event) => setRoom(Number(event.target.value) || null)}
                required
                disabled={busy}
              >
                <option value="">{t(MSG.COMBINED_SELECT_ROOM)}</option>
                {rooms.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
            </label>
            <CombinedDeviceWiring
              api={api}
              formId={formId}
              devices={devices}
              members={members}
              disabled={busy}
              onChange={selectSource}
              onAuthError={onAuthError}
            />
          </>
        )}
        {previewing && (
          <div className="combined-preview-layout">
            <div className="combined-preview-options">
              <label className="combined-power-option" htmlFor={`${formId}-show-all-power`}>
                {t(MSG.COMBINED_SHOW_ALL_POWER)}
                <Switch
                  id={`${formId}-show-all-power`}
                  checked={showAllPower}
                  disabled={busy}
                  onChange={setShowAllPower}
                />
              </label>
              <CombinedDeviceOrder members={previewMembers} disabled={busy} onMove={moveMember} />
            </div>
            <fieldset className="combined-preview dashboard-view" data-card-size={cardSize} disabled>
              <legend className="sr-only">{t(MSG.COMBINED_CARD_PREVIEW)}</legend>
              <p className="help">{t(MSG.COMBINED_CARD_PREVIEW_HELP)}</p>
              <ul className="dashboard-device-column">
                <CombinedDeviceCard
                  api={api}
                  combined={{ name: name.trim(), show_all_power: showAllPower }}
                  members={previewMembers}
                  room={roomName ?? t(MSG.NO_ROOM)}
                  now={now}
                  onAuthError={onAuthError}
                />
              </ul>
            </fieldset>
          </div>
        )}
        {error && <p className="field-error" role="alert">{translateText(error)}</p>}
        <div className="survey-footer">
          {existing && !previewing && (
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(true)}>{t(MSG.DISSOLVE_COMBINATION)}</button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t(MSG.CANCEL)}</button>
          {(previewing || (!existing && !pickingDevices)) && (
            <button type="button" className="secondary" disabled={busy} onClick={previewing ? onPreviewBack : () => setDraftStep('devices')}>
              {t(MSG.BACK)}
            </button>
          )}
          <button type="submit" disabled={!canSubmit}>{t(previewing ? MSG.SAVE : submitLabel)}</button>
        </div>
        {confirmDelete && (
          <div className="combined-delete">
            <p>{t(MSG.DISSOLVE_COMBINATION_QUESTION)}</p>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>{t(MSG.CANCEL)}</button>
            <button type="button" disabled={busy} onClick={() => remove()}>{t(MSG.DISSOLVE_COMBINATION)}</button>
          </div>
        )}
      </form>
    </>
  );
}
