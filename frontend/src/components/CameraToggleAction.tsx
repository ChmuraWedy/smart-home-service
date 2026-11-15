import { useCallback, useId, useState } from 'react';
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';
import { isStale } from '../controls';
import type { Reading } from '../home-api';
import { MSG, t } from '../i18n';
import powerControlState from '../power-control-state';
import { usePendingDeviceValue } from '../use-pending-device-value';
import { ParameterIcon } from './DevicePresentation';
import { PowerButton } from './PowerButton';
import { Icon } from './ui/icon';

export default function CameraToggleAction({
  pendingScope, spec, reading, now, disabled, onSend, appearance = 'card',
}: {
  pendingScope: string;
  spec: ControlSpec;
  reading?: Reading;
  now: number;
  disabled: boolean;
  onSend: (value: JsonValue) => Promise<boolean>;
  appearance?: 'card' | 'details';
}) {
  const id = useId();
  const [error, setError] = useState('');
  const { target, begin } = usePendingDeviceValue(pendingScope, spec.key, reading);
  const value = target?.value ?? (reading?.known ? reading.value : null);
  const state = powerControlState({
    value,
    draft: '',
    dirty: false,
    reading,
    fresh: Boolean(reading?.known && !isStale(reading, now, false)),
    awaiting: target !== undefined,
  });
  let description = t(MSG.NO_DATA);
  if (state.powerKnown) description = t(state.shownPower ? MSG.ON : MSG.OFF);
  const stateLabel = description;
  if (state.showStale) description += ` · ${t(MSG.STALE)}`;
  if (state.showPending) description += ` · ${t(MSG.WAITING_FOR_A_NEW_READING)}`;
  let icon = <ParameterIcon code={spec.key} />;
  if (spec.key === 'decibel_switch') icon = <Icon name="speaker" className="parameter-icon" />;
  if (spec.key === 'siren_switch') icon = <Icon name="siren" className="parameter-icon" />;
  const change = useCallback(async (checked: boolean) => {
    setError('');
    const accepted = begin(checked);
    try {
      if (await onSend(checked)) accepted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_REQUEST));
    }
  }, [begin, onSend]);
  return (
    <>
      <PowerButton
        id={id}
        label={spec.label}
        title={`${spec.label}: ${description}`}
        variant={appearance === 'details' ? 'button' : 'dashboard-switch'}
        checked={state.shownPower}
        known={state.powerKnown}
        icon={appearance === 'details' ? undefined : icon}
        buttonText={`${spec.label}: ${stateLabel}`}
        disabled={disabled || !state.powerKnown}
        onChange={change}
      />
      {state.showPending && <span className="sr-only" role="status">{t(MSG.WAITING_FOR_A_NEW_READING)}</span>}
      {error && <span className="sr-only" role="alert">{error}</span>}
    </>
  );
}
