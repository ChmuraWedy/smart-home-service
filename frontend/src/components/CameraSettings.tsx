import type { ReactNode } from 'react';
import type { ControlSpec } from '../controls';
import { cameraSettingsGroups } from '../camera-controls';

export function CameraSettings({ specs, renderField }: { specs:ControlSpec[]; renderField:(spec:ControlSpec)=>ReactNode }) {
  const {groups,additional} = cameraSettingsGroups(specs);
  if (!specs.length) return null;
  return <section className="camera-settings" aria-label="Настройки камеры">
    {groups.map(group => <section className="camera-setting-group" key={group.title} aria-label={group.title}>
      <h3>{group.title}</h3><div className="capability-grid">{group.specs.map(spec => renderField(spec))}</div>
    </section>)}
    {!!additional.length && <details className="cloud-properties"><summary>Дополнительные параметры камеры</summary>
      <div className="capability-grid">{additional.map(spec => renderField(spec))}</div>
    </details>}
  </section>;
}
