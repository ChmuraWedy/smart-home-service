import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import { deviceRoutes, matchesDevice, routeLabel } from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import type {
  CombinedDevice, CombinedMemberInput, HomeApi, Room,
} from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { ControlDialog } from './DeviceControls';
import type { ResolvedMember } from './CombinedDeviceCard';

export function CombinedDeviceDetails({
  combined, members, onChoose, onEdit, onClose,
}: {
  combined: CombinedDevice;
  members: ResolvedMember[];
  onChoose: (device: UnifiedDevice, route: DeviceRoute) => void;
  onEdit: () => void;
  onClose: () => void;
}) {
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
              {device?.name ?? member.device_id}
              {!device && ` · ${t(MSG.UNAVAILABLE)}`}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={onEdit}>{t(MSG.EDIT_COMBINATION)}</button>
    </ControlDialog>
  );
}

export function CombinedDeviceSettings({
  api, existing, devices, rooms, initialRoom, deviceRoom, onClose, onSaved, onAuthError,
}: {
  api: HomeApi;
  existing?: CombinedDevice;
  devices: UnifiedDevice[];
  rooms: Room[];
  initialRoom: number | null;
  deviceRoom: (device: UnifiedDevice) => number | null;
  onClose: () => void;
  onSaved: (saved?: CombinedDevice) => void;
  onAuthError: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(existing?.name ?? '');
  const [chosenRoom, setRoom] = useState(existing ? existing.room_id : initialRoom ?? undefined);
  const [members, setMembers] = useState<CombinedMemberInput[]>(() => existing?.members.map(({ device_id: id, route }) => ({ device_id: id, route })) ?? []);
  const [busy, setBusy] = useState(false);
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
  const options = [...new Set([...selected.keys(), ...devices.map((device) => device.id)])].filter((id) => {
    const device = byId.get(id);
    return selected.has(id) || (device && matchesDevice(device, search));
  });

  function handleFailure(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) onAuthError();
    else setError(failure instanceof Error ? failure.message : t(MSG.COMBINED_SAVE_FAILED));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || members.length < 2 || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveCombination({ name: name.trim(), room_id: room, members }, existing?.id);
      onSaved(saved);
    } catch (failure) {
      handleFailure(failure);
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
      onSaved();
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setBusy(false);
    }
  }

  function toggleMember(id: string, route: DeviceRoute | undefined, checked: boolean) {
    if (checked && route) setMembers((rows) => [...rows, { device_id: id, route }]);
    else setMembers((rows) => rows.filter((member) => member.device_id !== id));
  }

  function selectRoute(id: string, route: DeviceRoute) {
    setMembers((rows) => rows.map((member) => (member.device_id === id ? { ...member, route } : member)));
  }

  return (
    <ControlDialog title={t(existing ? MSG.EDIT_COMBINATION : MSG.COMBINE_DEVICES)} busy={busy} onClose={onClose}>
      <form className="combined-device-form" onSubmit={(event) => save(event)}>
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
          <select id={`${formId}-room`} value={room ?? ''} onChange={(event) => setRoom(Number(event.target.value) || null)} disabled={busy}>
            <option value="">{t(MSG.NO_ROOM)}</option>
            {rooms.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="field" htmlFor={`${formId}-search`}>
          {t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}
          <input id={`${formId}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <fieldset className="combined-members" disabled={busy}>
          <legend>{t(MSG.CHOOSE_COMBINED_DEVICES)}</legend>
          {options.map((id) => {
            const device = byId.get(id);
            const choice = selected.get(id);
            const routes = device ? deviceRoutes(device) : [];
            const label = device?.name ?? id;
            return (
              <div className="combined-member-option" key={id}>
                <label htmlFor={`${formId}-member-${id}`}>
                  <input
                    id={`${formId}-member-${id}`}
                    type="checkbox"
                    checked={Boolean(choice)}
                    disabled={!choice && (members.length >= 16 || !routes.length)}
                    onChange={(event) => toggleMember(id, routes[0], event.target.checked)}
                  />
                  {label}
                </label>
                {choice && routes.length > 0 && (
                  <select
                    value={choice.route}
                    aria-label={t(MSG.CONTROL_METHOD) + label}
                    onChange={(event) => selectRoute(id, event.target.value as DeviceRoute)}
                  >
                    {!routes.includes(choice.route) && <option value={choice.route}>{routeLabel[choice.route]} · {t(MSG.UNAVAILABLE)}</option>}
                    {routes.map((route) => <option value={route} key={route}>{routeLabel[route]}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </fieldset>
        {error && <p className="field-error" role="alert">{translateText(error)}</p>}
        <div className="survey-footer">
          <button type="submit" disabled={busy || members.length < 2 || !name.trim()}>{t(MSG.SAVE)}</button>
          {existing && (
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(true)}>{t(MSG.DISSOLVE_COMBINATION)}</button>
          )}
        </div>
        {confirmDelete && (
          <div className="combined-delete">
            <p>{t(MSG.DISSOLVE_COMBINATION_QUESTION)}</p>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>{t(MSG.CANCEL)}</button>
            <button type="button" disabled={busy} onClick={() => remove()}>{t(MSG.DISSOLVE_COMBINATION)}</button>
          </div>
        )}
      </form>
    </ControlDialog>
  );
}
