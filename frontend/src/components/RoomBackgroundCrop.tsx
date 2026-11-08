import {
  useCallback, useEffect, useId, useRef, useState,
} from 'react';
import { MSG, t, translateText } from '../i18n';
import { decodeRoomBackground, drawRoomBackground, encodeRoomBackground } from '../room-appearance';
import { LightRange } from './LightColorWheel';
import { WizardDialog } from './WizardDialog';

const shapes = [
  { value: 'original', label: MSG.ROOM_CROP_ORIGINAL },
  { value: 'portrait', label: MSG.ROOM_CROP_PORTRAIT, ratio: 3 / 4 },
  { value: 'landscape', label: MSG.ROOM_CROP_LANDSCAPE, ratio: 16 / 9 },
  { value: 'square', label: MSG.ROOM_CROP_SQUARE, ratio: 1 },
];

export default function RoomBackgroundCrop({
  source, onSave, onClose,
}: { source: Blob; onSave: (image: Blob) => void; onClose: () => void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  const [shape, setShape] = useState('original');
  const [zoom, setZoom] = useState(100);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shapeId = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const liveBitmap = useRef<ImageBitmap | undefined>(undefined);
  const ratio = shapes.find(({ value }) => value === shape)?.ratio;

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
      drawRoomBackground(bitmap, canvas.current, 600, {
        ratio, zoom: zoom / 100, x: x / 100, y: y / 100,
      });
    } catch {
      setError(t(MSG.ROOM_BACKGROUND_FORMAT_ERROR));
    }
  }, [bitmap, ratio, x, y, zoom]);

  async function save() {
    if (!bitmap || saving) return;
    setSaving(true);
    setError('');
    try {
      const image = await encodeRoomBackground(bitmap, {
        ratio, zoom: zoom / 100, x: x / 100, y: y / 100,
      });
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
          <label htmlFor={shapeId}>{t(MSG.ROOM_CROP_SHAPE)}</label>
          <select id={shapeId} value={shape} disabled={saving} onChange={(event) => setShape(event.currentTarget.value)}>
            {shapes.map(({ value, label }) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
          <canvas ref={canvas} className="room-crop-preview" aria-label={t(MSG.ROOM_CROP_PREVIEW)} />
          <LightRange
            label={t(MSG.ROOM_CROP_ZOOM)}
            min={100}
            max={300}
            suffix="%"
            value={zoom}
            disabled={saving}
            onChange={setZoom}
          />
          <LightRange
            label={t(MSG.ROOM_CROP_HORIZONTAL)}
            max={100}
            suffix="%"
            value={x}
            disabled={saving}
            onChange={setX}
          />
          <LightRange
            label={t(MSG.ROOM_CROP_VERTICAL)}
            max={100}
            suffix="%"
            value={y}
            disabled={saving}
            onChange={setY}
          />
        </div>
      )}
    </WizardDialog>
  );
}
