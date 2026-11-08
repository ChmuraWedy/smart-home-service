import type { JsonValue } from '../api';
import { hsvToHex } from '../controls';
import { MSG, t } from '../i18n';
import { isWhiteUnit, sceneEffectLabels } from '../light-scenes';
import type { SceneUnit } from '../light-scenes';
import { ParameterIcon } from './DevicePresentation';
import { Icon } from './ui/icon';

export function temperatureTint(value: JsonValue | undefined, minimum?: number, maximum?: number) {
  if (typeof value !== 'number' || minimum === undefined || maximum === undefined || maximum <= minimum) return undefined;
  const cool = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const warm = [255, 191, 86];
  const cold = [184, 218, 255];
  const channels = warm.map((channel, index) => Math.round(channel + (cold[index] - channel) * cool));
  return `rgb(${channels.join(', ')})`;
}

type LightCardReadingProps = {
  code: 'brightness' | 'color_temperature' | 'color' | 'scene';
  label: string;
  value?: string;
  tint?: string;
  off?: boolean;
};

export function LightCardReading({
  code, label, value, tint, off,
}: LightCardReadingProps) {
  let caption;
  if (off) {
    caption = (
      <>
        <span className="dashboard-light-off-label">{value}</span>
        <span className="dashboard-light-off-mark" aria-hidden="true">—</span>
      </>
    );
  } else if (value) {
    caption = <span className="dashboard-light-value-text">{value}</span>;
  } else {
    caption = (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t(MSG.NO_DATA)}</span>
      </>
    );
  }
  return (
    <span className="dashboard-light-reading" title={value ? `${label} · ${value}` : label}>
      {tint && <span className="dashboard-light-tint" style={{ backgroundColor: tint }} aria-hidden="true" />}
      <span className="dashboard-light-copy">
        <span className="dashboard-light-icon">
          {code === 'scene'
            ? <Icon name="sliders" className="parameter-icon" />
            : <ParameterIcon code={code} />}
        </span>
        <span className="dashboard-light-label">{label}</span>
        <span className="dashboard-light-value">
          {caption}
          {code === 'color' && tint && <span className="dashboard-light-swatch" style={{ backgroundColor: tint }} aria-hidden="true" />}
        </span>
      </span>
    </span>
  );
}

export function LightSceneReadings({ unit }: { unit: SceneUnit }) {
  const effect = unit.unit_change_mode;
  if (effect !== 'static') {
    return <LightCardReading code="scene" label={t(MSG.SCENE)} value={t(sceneEffectLabels[effect])} />;
  }

  const white = isWhiteUnit(unit);
  const brightness = (white ? unit.bright : unit.v) / 10;
  const color = white ? undefined : hsvToHex(unit).toUpperCase();
  return (
    <>
      <LightCardReading code="brightness" label={t(MSG.BRIGHTNESS)} value={`${brightness} %`} />
      {white ? (
        <LightCardReading
          code="color_temperature"
          label={t(MSG.COLOR_TEMPERATURE)}
          value={`${unit.temperature / 10} %`}
          tint={temperatureTint(unit.temperature, 0, 1000)}
        />
      ) : <LightCardReading code="color" label={t(MSG.COLOR)} value={color} tint={color} />}
    </>
  );
}
