import { MSG, t } from "../i18n";
import type { ReactNode } from 'react';
import type { ControlSpec } from '../controls';
import { cameraSettingsGroups } from '../camera-controls';

export function CameraSettings({ specs, renderField }: { specs:ControlSpec[]; renderField:(spec:ControlSpec)=>ReactNode }) {
  const {groups,additional} = cameraSettingsGroups(specs);
  if (!specs.length) return null;
  return <section className="camera-settings" aria-label={t(MSG.CAMERA_SETTINGS)}>
    {groups.map(group => <section className="camera-setting-group" key={group.specs[0].key} aria-label={group.title}>
      <h3>{group.title}</h3><div className="capability-grid">{group.specs.map(spec => renderField(spec))}</div>
    </section>)}
    {!!additional.length && <details className="cloud-properties"><summary>{t(MSG.ADDITIONAL_CAMERA_SETTINGS)}</summary>
      <div className="capability-grid">{additional.map(spec => renderField(spec))}</div>
    </details>}
  </section>;
}
