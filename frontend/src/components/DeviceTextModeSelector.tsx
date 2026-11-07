import { useId } from 'react';
import { setDeviceTextMode, useDeviceTextMode } from '../device-translations';
import { MSG, t } from '../i18n';

export default function DeviceTextModeSelector() {
  const inputId = useId();
  const mode = useDeviceTextMode();
  return (
    <label htmlFor={inputId}>
      <span>{t(MSG.DEVICE_LABEL_DISPLAY)}</span>
      <select id={inputId} value={mode} onChange={(event) => setDeviceTextMode(event.target.value === 'localized' ? 'localized' : 'original')}>
        <option value="original">{t(MSG.DEVICE_LABELS_ORIGINAL)}</option>
        <option value="localized">{t(MSG.DEVICE_LABELS_LOCALIZED)}</option>
      </select>
    </label>
  );
}
