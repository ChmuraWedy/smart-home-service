import { CloudApi } from './api';
import type { JsonValue } from './api';

export type Capability = {
  type: 'boolean' | 'integer' | 'number' | 'string' | 'object';
  readable: boolean; writable: boolean; minimum?: number | null; maximum?: number | null;
  step?: number | null; enum?: JsonValue[] | null; unit?: string | null; encoding?: string;
};
export type Reading = { value: JsonValue; known: boolean; stale: boolean; observed_at?: string | null; received_at?:string; source?:string };
export type DeviceState = { device_id: number; name: string; enabled: boolean; available: boolean; values: Record<string, Reading> };
export type LocalDevice = {
  id: number; device_id: string; name: string; aliases: string[]; building_id: number | null;
  room_id: number | null; transport: 'wifi' | 'zigbee'; parent_id: number | null; cid: string | null;
  enabled: boolean; capabilities: Record<string, Capability>;
};
export type Building = { id: number; name: string; aliases: string[] };
export type Room = { id: number; building_id: number; name: string; aliases: string[] };
export type Group = { id: number; name: string; room_id: number; device_ids: number[] };
export type GroupState = { group_id: number; state: 'on' | 'off' | 'mixed' | 'unknown'; members: DeviceState[] };
export type GroupResult = { all_acknowledged: boolean; results: { device_id: number; acknowledged: boolean }[] };
export type Inventory = { buildings: Building[]; rooms: Room[]; devices: LocalDevice[]; groups: Group[] };

export class HomeApi extends CloudApi {
  private async list<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    // Page metadata only; loading the inventory never contacts physical devices.
    for (let offset = 0; offset < 10_000; offset += 500) {
      const page = await this.request<T[]>(`${path}?offset=${offset}&limit=500`, 'GET', undefined, signal);
      if (!Array.isArray(page)) throw new Error('Сервис вернул неожиданный список.');
      result.push(...page);
      if (page.length < 500) return result;
    }
    throw new Error('Список слишком большой. Используйте REST API для такого инвентаря.');
  }
  async inventory(signal?: AbortSignal): Promise<Inventory> {
    const [buildings, rooms, devices, groups] = await Promise.all([
      this.list<Building>('/buildings', signal), this.list<Room>('/rooms', signal),
      this.list<LocalDevice>('/devices', signal), this.list<Group>('/groups', signal),
    ]);
    return { buildings, rooms, devices, groups };
  }
  device(id: number, signal?: AbortSignal) { return this.request<LocalDevice>(`/devices/${id}`, 'GET', undefined, signal); }
  state(id: number, refresh = false, signal?: AbortSignal) {
    return this.request<DeviceState>(`/devices/${id}/state?refresh=${refresh}&max_age=60`, 'GET', undefined, signal);
  }
  setCapability(id: number, name: string, value: JsonValue) {
    return this.request<{ acknowledged: boolean }>(`/devices/${id}/commands/capabilities`, 'POST', { values: { [name]: value } });
  }
  groupState(id: number, signal?: AbortSignal) { return this.request<GroupState>(`/groups/${id}/state`, 'GET', undefined, signal); }
  groupCommand(id: number, command: 'on' | 'off') { return this.request<GroupResult>(`/groups/${id}/commands/${command}`, 'POST'); }
}
