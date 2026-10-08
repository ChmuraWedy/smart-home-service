import { useCallback, useState } from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, CloudSnapshot, Provider } from '../api';
import { cloudCommands, cloudReading, cloudSpecs } from '../controls';
import type { ControlSpec } from '../controls';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceMappings } from './DeviceMappings';

export function CloudControl({ api, device, provider, devices, onClose, onAuthError }: {
  api: CloudApi; device: CloudDevice; provider: Provider; devices?: CloudDevice[]; onClose: () => void; onAuthError: () => void;
}) {
  const [mappingBusy,setMappingBusy] = useState(false);
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const [definitions, snapshot] = await Promise.all([api.deviceFunctions(device.id, provider, signal), api.deviceSnapshot(device.id, provider, signal)]);
    if (definitions.device_id !== device.id || snapshot.device_id !== device.id || !Array.isArray(definitions.functions) || !snapshot.status || typeof snapshot.status !== 'object') throw new Error('Сервис вернул неожиданные данные устройства.');
    return { definitions, snapshot, fetchedAt: Date.now() };
  }, [api, device.id, provider]);
  const session = useControlSession<{ definitions: CloudFunctions; snapshot: CloudSnapshot; fetchedAt: number }>(load, onAuthError);
  const now = useClock();
  const specs = session.data ? cloudSpecs(session.data.definitions, session.data.snapshot) : [];
  const basic = specs.filter(spec => !spec.advanced), advanced = specs.filter(spec => spec.advanced);
  const field = (spec: ControlSpec) => <CapabilityField key={spec.key} spec={spec} reading={cloudReading(spec, session.data!.snapshot.status[spec.key])} now={now} local={false} disabled={mappingBusy || session.busy || !session.readOK || !session.data!.snapshot.online} onSend={value => session.execute(async () => {
    const result = await api.sendDeviceCommands(device.id, provider, cloudCommands(spec, value, session.data!.definitions));
    if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
    return { text: 'Команда принята.' };
  })} />;
  return <ControlDialog title={device.name || 'Устройство Tuya'} subtitle={provider === 'sharing' ? 'Smart Life · через интернет' : 'Tuya Developer · через интернет'} busy={session.busy || mappingBusy} onClose={onClose}>
    <div className="control-toolbar"><span className={'presence' + (session.data?.snapshot.online ? ' online' : '')}>{session.data ? (session.data.snapshot.online ? 'В сети' : 'Не в сети') : 'Проверяем связь'}</span><button className="secondary compact" disabled={session.busy || mappingBusy} onClick={() => void session.refresh()}>Обновить статус</button></div>
    <p className="help">{specs.some(spec => spec.writable) ? 'Облачный снимок состояния. Принятие команды не подтверждает изменение устройства; облако может вернуть прежнее показание.' : 'Последнее известное состояние в облаке. Обновите статус для получения нового снимка.'}</p>
    {session.data && <p className="help">Снимок получен: {new Date(session.data.fetchedAt).toLocaleString('ru-RU')}</p>}
    {session.data && !session.data.snapshot.online && <p className="saved-summary">Устройство не в сети. Обновите статус после восстановления связи.</p>}
    {basic.length > 0 && <div className="capability-grid">{basic.map(field)}</div>}
    {advanced.length > 0 && <details className="cloud-properties advanced-controls"><summary>Эффекты и дополнительные параметры</summary>
      <p className="help">Составные команды и параметры производителя. Здесь нужны значения в формате устройства; основные настройки света доступны выше.</p>
      <div className="capability-grid">{advanced.map(field)}</div>
    </details>}
    {session.data && !specs.length && <p className="empty-state">Устройство не предоставило показаний или возможностей управления.</p>}
    {session.data && <details className="cloud-properties"><summary>Свойства устройства</summary><dl>
      <div><dt>ID устройства</dt><dd><code>{device.id}</code></dd></div>
      <div><dt>Тип</dt><dd>{device.category === 'pir' ? 'Датчик движения' : device.category || 'Не указан'}</dd></div>
      <div><dt>Подключение</dt><dd>{device.sub ? 'Через шлюз' : 'Прямое'}</dd></div>
      <div><dt>Доступ</dt><dd>{session.data.definitions.functions.length ? 'Чтение и команды' : 'Только чтение'}</dd></div>
    </dl><ul>{[...session.data.definitions.functions,...(session.data.definitions.status_range || [])].filter((spec,index,all) => all.findIndex(s => s.code === spec.code) === index).map(spec => <li key={spec.code}><code>{spec.code}</code> · {spec.type} · {spec.dp_ids?.length ? 'DP '+spec.dp_ids.join(', ') : spec.dp_id ? 'DP '+spec.dp_id : 'Номер DP не указан'}</li>)}</ul></details>}
    {session.data && <DeviceMappings api={api} device={device} devices={devices} provider={provider} definitions={session.data.definitions} disabled={session.busy} onBusy={setMappingBusy} onAuthError={onAuthError} />}
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
