import { useEffect, useState } from 'react';
import { MSG, t } from './i18n';
import type { HomeApi, RoomAppearance } from './home-api';

export const BACKGROUND_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_PHOTO_BYTES = 20 * MAX_UPLOAD_BYTES;

export async function prepareRoomBackground(file: File): Promise<Blob> {
  if (!BACKGROUND_TYPES.includes(file.type)) throw new Error(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
  if (file.size > MAX_PHOTO_BYTES) throw new Error(t(MSG.ROOM_BACKGROUND_SIZE_ERROR));
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1440 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error();
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.75); });
    if (image && image.size <= MAX_UPLOAD_BYTES) return image;
  } catch {
    throw new Error(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
  } finally {
    bitmap?.close();
  }
  throw new Error(t(MSG.ROOM_BACKGROUND_SIZE_ERROR));
}

type RoomAppearanceResult = { appearance: RoomAppearance; backgroundUrl?: string };
type RoomAppearanceRead = { api: HomeApi; roomId: number; value?: RoomAppearanceResult; error?: unknown };

export function useRoomAppearance(api: HomeApi, roomId: number | undefined, revision = 0) {
  const [read, setRead] = useState<RoomAppearanceRead>();
  useEffect(() => {
    if (roomId === undefined) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let backgroundUrl: string | undefined;
    async function load(id: number) {
      try {
        const appearance = await api.roomAppearance(id, signal);
        if (appearance.background_version) {
          const image = await api.roomBackground(id, signal);
          if (!signal.aborted) backgroundUrl = URL.createObjectURL(image);
        }
        if (!signal.aborted) setRead({ api, roomId: id, value: { appearance, backgroundUrl } });
      } catch (error) {
        if (!signal.aborted) setRead({ api, roomId: id, error });
      }
    }
    load(roomId);
    return () => {
      controller.abort();
      if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
    };
  }, [api, roomId, revision]);
  return read?.api === api && read.roomId === roomId ? read : undefined;
}
