import { useEffect, useState } from 'react';
import { MSG, t } from './i18n';
import type { HomeApi, RoomAppearance } from './home-api';

export const BACKGROUND_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_PHOTO_BYTES = 20 * MAX_UPLOAD_BYTES;

export type RoomBackgroundCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function validateRoomBackground(source: Blob) {
  if (!BACKGROUND_TYPES.includes(source.type)) throw new Error(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
  if (source.size > MAX_PHOTO_BYTES) throw new Error(t(MSG.ROOM_BACKGROUND_SIZE_ERROR));
}

export async function decodeRoomBackground(source: Blob) {
  validateRoomBackground(source);
  try {
    return await createImageBitmap(source);
  } catch {
    throw new Error(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
  }
}

export function drawRoomBackground(bitmap: ImageBitmap, canvas: HTMLCanvasElement, maximum: number, crop?: RoomBackgroundCrop) {
  const width = bitmap.width * (crop?.width ?? 1);
  const height = bitmap.height * (crop?.height ?? 1);
  const scale = Math.min(1, maximum / Math.max(width, height));
  canvas.setAttribute('width', String(Math.max(1, Math.round(width * scale))));
  canvas.setAttribute('height', String(Math.max(1, Math.round(height * scale))));
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
  if (crop) {
    const x = bitmap.width * crop.x;
    const y = bitmap.height * crop.y;
    context.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
  } else {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
}

export async function encodeRoomBackground(bitmap: ImageBitmap, crop?: RoomBackgroundCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  drawRoomBackground(bitmap, canvas, 1440, crop);
  const image = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.75); });
  if (image && image.size <= MAX_UPLOAD_BYTES) return image;
  throw new Error(t(MSG.ROOM_BACKGROUND_SIZE_ERROR));
}

export async function prepareRoomBackground(file: File): Promise<Blob> {
  if (file.size <= MAX_UPLOAD_BYTES) {
    validateRoomBackground(file);
    return file;
  }
  const bitmap = await decodeRoomBackground(file);
  try {
    return await encodeRoomBackground(bitmap);
  } finally {
    bitmap.close();
  }
}

type RoomAppearanceResult = { appearance: RoomAppearance; backgroundUrl?: string; background?: Blob };
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
        const background = appearance.background_version ? await api.roomBackground(id, signal) : undefined;
        if (signal.aborted) return;
        if (background) backgroundUrl = URL.createObjectURL(background);
        setRead({ api, roomId: id, value: { appearance, backgroundUrl, background } });
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
