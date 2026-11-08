import { useDeviceText } from './device-translations';
import type { Room } from './home-api';

export default function useRoomName() {
  const localize = useDeviceText();
  return (room?: Room) => (room ? localize(room.name, room.name_translations) : '');
}
