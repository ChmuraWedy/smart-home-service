import type { ControlSpec } from './controls';
import { supportsSimpleScenes } from './light-scenes';

export default function lightControls(specs: ControlSpec[], singlePower: boolean) {
  const available = singlePower ? specs : [];
  const brightness = available.find((spec) => spec.readable && spec.kind === 'number'
    && /^(brightness|bright_value(?:_v2)?)$/.test(spec.key));
  const temperature = available.find((spec) => spec.readable && spec.kind === 'number'
    && /^(temp_value(?:_v2)?|color_temperature)$/.test(spec.key));
  const color = available.find((spec) => spec.readable && spec.kind === 'color' && /^(color|colour_data(?:_v2)?)$/.test(spec.key));
  const white = [brightness, temperature].filter((spec): spec is ControlSpec => spec !== undefined);
  const mode = available.find((spec) => spec.key === 'work_mode' || spec.key === 'mode');
  const scene = available.find((spec) => spec.writable && supportsSimpleScenes(spec));
  return {
    brightness, temperature, color, white, mode, scene,
  };
}
