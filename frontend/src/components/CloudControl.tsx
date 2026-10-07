import { useCallback } from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, CloudSnapshot, Provider } from '../api';
import { cloudCommands, cloudReading, cloudSpecs } from '../controls';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';

export function CloudControl({ api, device, provider, onClose, onAuthError }: {
  api: CloudApi; device: CloudDevice; provider: Provider; onClose: () => void; onAuthError: () => void;
}) {
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const [definitions, snapshot] = await Promise.all([api.deviceFunctions(device.id, provider, signal), api.deviceSnapshot(device.id, provider, signal)]);
    if (definitions.device_id !== device.id || snapshot.device_id !== device.id || !Array.isArray(definitions.functions) || !snapshot.status || typeof snapshot.status !== 'object') throw new Error('Сервис вернул неожиданные данные устройства.');
    return { definitions, snapshot, fetchedAt: Date.now() };
  }, [api, device.id, provider]);
  const session = useControlSession<{ definitions: CloudFunctions; snapshot: CloudSnapshot; fetchedAt: number }>(load, onAuthError);
  const now = useClock();
  const specs = session.data ? cloudSpecs(session.data.definitions, session.data.snapshot) : [];
  return <ControlDialog title={device.name || 'Устройство Tuya'} subtitle={provider === 'sharing' ? 'Smart Life · через интернет' : 'Tuya Developer · через интернет'} busy={session.busy} onClose={onClose}>
    <div className="control-toolbar"><span className={'presence' + (session.data?.snapshot.online ? ' online' : '')}>{session.data ? (session.data.snapshot.online ? 'В сети' : 'Не в сети') : 'Проверяем связь'}</span><button className="secondary compact" disabled={session.busy} onClick={() => void session.refresh()}>Обновить статус</button></div>
    <p className="help">{specs.some(spec => spec.writable) ? 'Облачный снимок состояния. Принятие команды не подтверждает изменение устройства; облако может вернуть прежнее показание.' : 'Последнее известное состояние в облаке. Обновите статус для получения нового снимка.'}</p>
    {session.data && <p className="help">Снимок получен: {new Date(session.data.fetchedAt).toLocaleString('ru-RU')}</p>}
    {session.data && !session.data.snapshot.online && <p className="saved-summary">Устройство не в сети. Обновите статус после восстановления связи.</p>}
    <div className="capability-grid">{specs.map(spec => <CapabilityField key={spec.key} spec={spec} reading={cloudReading(spec, session.data!.snapshot.status[spec.key])} now={now} local={false} disabled={session.busy || !session.readOK || !session.data!.snapshot.online} onSend={value => session.execute(async () => {
      const result = await api.sendDeviceCommands(device.id, provider, cloudCommands(spec, value, session.data!.definitions));
      if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
      return { text: 'Команда принята.' };
    })} />)}</div>
    {session.data && !specs.length && <p className="empty-state">Устройство не предоставило показаний или возможностей управления.</p>}
    {session.data && <details className="cloud-properties"><summary>Свойства устройства</summary><dl>
      <div><dt>Тип</dt><dd>{device.category === 'pir' ? 'Датчик движения' : device.category || 'Не указан'}</dd></div>
      <div><dt>Подключение</dt><dd>{device.sub ? 'Через шлюз' : 'Прямое'}</dd></div>
      <div><dt>Доступ</dt><dd>{session.data.definitions.functions.length ? 'Чтение и команды' : 'Только чтение'}</dd></div>
    </dl></details>}
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
