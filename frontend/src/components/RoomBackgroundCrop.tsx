import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { MSG, t, translateText } from '../i18n';
import { decodeRoomBackground, drawRoomBackground, encodeRoomBackground } from '../room-appearance';
import type { RoomBackgroundCrop as Crop } from '../room-appearance';
import { WizardDialog } from './WizardDialog';

type Point = Pick<Crop, 'x' | 'y'>;
type Drag = {
  pointer: number;
  mode: 'draw' | 'move' | 'resize';
  start: Point;
  initial: Crop;
};

const FULL_IMAGE: Crop = {
  x: 0, y: 0, width: 1, height: 1,
};
const MIN_SIZE = 0.02;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function pointerPosition(event: PointerEvent<HTMLDivElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function adjust(crop: Crop, mode: 'move' | 'resize', dx: number, dy: number): Crop {
  if (mode === 'resize') {
    return {
      ...crop,
      width: clamp(crop.width + dx, MIN_SIZE, 1 - crop.x),
      height: clamp(crop.height + dy, MIN_SIZE, 1 - crop.y),
    };
  }
  return {
    ...crop,
    x: clamp(crop.x + dx, 0, 1 - crop.width),
    y: clamp(crop.y + dy, 0, 1 - crop.height),
  };
}

const arrows: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export default function RoomBackgroundCrop({
  source, onSave, onClose,
}: { source: Blob; onSave: (image: Blob) => void; onClose: () => void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  const [crop, setCrop] = useState(FULL_IMAGE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const liveBitmap = useRef<ImageBitmap | undefined>(undefined);
  const drag = useRef<Drag | null>(null);
  const fullImage = crop.width === 1 && crop.height === 1;

  useEffect(() => {
    let closed = false;
    decodeRoomBackground(source).then((image) => {
      if (closed) image.close();
      else {
        liveBitmap.current = image;
        setBitmap(image);
      }
    }).catch((failure: Error) => {
      if (!closed) setError(translateText(failure.message));
    });
    return () => {
      closed = true;
      liveBitmap.current?.close();
      liveBitmap.current = undefined;
    };
  }, [source]);

  useEffect(() => {
    if (!bitmap || !canvas.current) return;
    try {
      drawRoomBackground(bitmap, canvas.current, 720);
    } catch {
      setError(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
    }
  }, [bitmap]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (saving || drag.current || event.button !== 0) return;
    const target = event.target as HTMLElement;
    let mode: Drag['mode'] = 'draw';
    if (target.closest('.room-crop-handle')) mode = 'resize';
    else if (!fullImage && target.closest('.room-crop-selection')) mode = 'move';
    drag.current = {
      mode, pointer: event.pointerId, start: pointerPosition(event), initial: crop,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updateDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const position = pointerPosition(event);
    const dx = position.x - active.start.x;
    const dy = position.y - active.start.y;
    if (active.mode !== 'draw') {
      setCrop(adjust(active.initial, active.mode, dx, dy));
      return;
    }
    if (Math.abs(dx) >= MIN_SIZE && Math.abs(dy) >= MIN_SIZE) {
      setCrop({
        x: Math.min(active.start.x, position.x),
        y: Math.min(active.start.y, position.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      });
    }
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    updateDrag(event);
    drag.current = null;
  };

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    setCrop(drag.current.initial);
    drag.current = null;
  };

  const adjustWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = arrows[event.key];
    if (!step) return;
    event.preventDefault();
    setCrop((current) => adjust(current, event.shiftKey ? 'resize' : 'move', step.x / 100, step.y / 100));
  };

  async function save() {
    if (!bitmap || saving) return;
    setSaving(true);
    setError('');
    try {
      const image = await encodeRoomBackground(bitmap, crop);
      if (liveBitmap.current === bitmap) onSave(image);
    } catch (failure) {
      if (liveBitmap.current === bitmap) setError(failure instanceof Error ? translateText(failure.message) : t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
    } finally {
      if (liveBitmap.current === bitmap) setSaving(false);
    }
  }

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  return (
    <WizardDialog
      title={t(MSG.ROOM_CROP_IMAGE)}
      onClose={close}
      actions={(
        <button type="button" disabled={!bitmap || saving} onClick={save}>{t(MSG.SAVE)}</button>
      )}
    >
      {!bitmap && !error && <p role="status">{t(MSG.LOADING_LIST)}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {bitmap && (
        <div className="room-crop-controls">
          <p className="help">{t(MSG.ROOM_CROP_HELP)}</p>
          <div
            className="room-crop-stage"
            onPointerDown={startDrag}
            onPointerMove={updateDrag}
            onPointerUp={finishDrag}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
          >
            <canvas ref={canvas} className="room-crop-preview" aria-label={t(MSG.ROOM_CROP_PREVIEW)} />
            <button
              type="button"
              className="room-crop-selection"
              aria-label={t(MSG.ROOM_CROP_REGION)}
              data-full-image={fullImage || undefined}
              disabled={saving}
              onKeyDown={adjustWithKeys}
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.width * 100}%`,
                height: `${crop.height * 100}%`,
              }}
            >
              <span className="room-crop-handle" aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="secondary compact" disabled={fullImage || saving} onClick={() => setCrop(FULL_IMAGE)}>
            {t(MSG.ROOM_CROP_RESET)}
          </button>
        </div>
      )}
    </WizardDialog>
  );
}
