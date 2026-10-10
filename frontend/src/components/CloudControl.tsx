import { useCallback, useMemo, useState } from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, CloudSnapshot, Provider } from '../api';
import { cloudBatchCommands, cloudCommands, cloudReading, cloudSpecs, withChannelLabels } from '../controls';
import type { ControlSpec } from '../controls';
import { CapabilityField, ControlApply, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceMappings } from './DeviceMappings';
import { ChannelAliases } from './ChannelAliases';
import { DeviceNetwork } from './DeviceNetwork';
import { useControlDrafts } from '../control-drafts';
import { DeviceAliases } from './DeviceAliases';
import { BatteryBadge, batteryFromSpecs, isBattery } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { connectionLabel, DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';
import { hasLightEffectWizard } from './LightEffectWizard';
import { hasScheduleWizard } from './ScheduleWizard';
import { ChannelControl, channelTimer } from './ChannelControl';
import type { ReactNode } from 'react';

export function CloudControl({ api, device, provider, devices, room, localTransport, onClose, onAuthError }: {
  api: CloudApi; device: CloudDevice; provider: Provider; devices?: CloudDevice[]; room?: string; localTransport?: 'wifi' | 'zigbee'; onClose: () => void; onAuthError: () => void;
}) {
  const [mappingBusy,setMappingBusy] = useState(false);
  const [aliasBusy, setAliasBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false), [labels, setLabels] = useState<Record<string, string> | null>(null);
  const editingBusy = mappingBusy || labelBusy || aliasBusy;
  const metadata = useMemo(() => ({value:null as CloudFunctions|null}),[api,device.id,provider]);
  const checked = (snapshot:CloudSnapshot) => {
    if (snapshot.device_id !== device.id || !snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) throw new Error('Сервис вернул неожиданные данные устройства.');
    return snapshot;
  };
  const receiptTime = (snapshot:CloudSnapshot) => snapshot.snapshot_received_at && Number.isFinite(Date.parse(snapshot.snapshot_received_at)) ? Date.parse(snapshot.snapshot_received_at) : Date.now();
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const [definitions, snapshot] = await Promise.all([metadata.value ? Promise.resolve(metadata.value) : api.deviceFunctions(device.id, provider, signal), api.deviceSnapshot(device.id, provider, signal)]);
    if (definitions.device_id !== device.id || snapshot.device_id !== device.id || !Array.isArray(definitions.functions) || !snapshot.status || typeof snapshot.status !== 'object') throw new Error('Сервис вернул неожиданные данные устройства.');
    if (!signal?.aborted) metadata.value = definitions;
    return { definitions, snapshot:checked(snapshot), fetchedAt: receiptTime(snapshot) };
  }, [api, device.id, provider,metadata]);
  type Data = { definitions: CloudFunctions; snapshot: CloudSnapshot; fetchedAt: number };
  const poll = useCallback(async (current:Data, signal:AbortSignal) => {
    const snapshot = checked(await api.deviceSnapshot(device.id,provider,signal,false));
    return {...current,snapshot,fetchedAt:snapshot.snapshot_received_at ? receiptTime(snapshot) : current.fetchedAt};
  },[api,device.id,provider]);
  const session = useControlSession<Data>(load, onAuthError, provider === 'sharing' && !editingBusy ? poll : undefined);
  const now = useClock(), drafts = useControlDrafts();
  const definitions = session.data ? labels ? withChannelLabels(session.data.definitions, labels) : session.data.definitions : null;
  const specs = session.data && definitions ? cloudSpecs(definitions, session.data.snapshot) : [];
  const settings = specs.filter(spec => /^(relay_status(?:_[1-9][0-9]*)?|switch_backlight|switch_inching)$/.test(spec.key));
  const basic = specs.filter(spec => !spec.advanced && !hasLightEffectWizard(spec) && !settings.includes(spec) && !isBattery(spec.key)), schedules = specs.filter(hasScheduleWizard), effects = specs.filter(hasLightEffectWizard), advanced = specs.filter(spec => spec.advanced && !settings.includes(spec) && !hasScheduleWizard(spec) && !hasLightEffectWizard(spec));
  const field = (spec: ControlSpec, headingActions?: ReactNode) => <CapabilityField headingActions={headingActions} key={spec.key} spec={spec} stage={drafts.stage} reading={cloudReading(spec, session.data!.snapshot.status[spec.key], session.data!.snapshot.status_observations?.[spec.key])} now={now} local={false} onRefresh={session.refresh} aliasEditor={/^switch_[1-9][0-9]*$/.test(spec.key) ? <ChannelAliases api={api} deviceId={device.id} provider={provider} code={spec.key} alias={spec.aliases?.[0]} disabled={session.busy || mappingBusy || aliasBusy || labelBusy} onBusy={setLabelBusy} onSaved={setLabels} onAuthError={onAuthError} /> : undefined} disabled={editingBusy || session.busy || !session.readOK} onSend={value => session.execute(async () => {
    const result = await api.sendDeviceCommands(device.id, provider, cloudCommands(spec, value, session.data!.definitions));
    if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
    return { text: 'Команда принята.' };
  })} />;
  const pairedTimers = new Set(basic.flatMap(spec => { const timer = channelTimer(spec,basic); return timer ? [timer.key] : []; }));
  const basicField = (spec:ControlSpec) => <ChannelControl key={spec.key} spec={spec} timer={channelTimer(spec,basic)} renderField={field} />;
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  return <ControlDialog onRefresh={session.refresh} information={<DeviceConnectionDescription room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} />} statusContent={<BatteryBadge reading={session.data ? batteryFromSpecs(specs,session.data.snapshot.status) : device.battery} />} className={device.category === 'dj' || specs.some(spec => spec.kind === 'color') ? 'bulb-controls' : ''} title={device.name || 'Устройство Tuya'} busy={session.busy || editingBusy} onClose={onClose} titleContent={<DeviceAliases api={api} deviceId={device.id} name={device.name} initialAliases={device.aliases} provider={provider} disabled={session.busy || mappingBusy || labelBusy} onBusy={setAliasBusy} onAuthError={onAuthError} />} connectionContent={<DeviceConnectionSummary room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} status={session.data ? (session.data.snapshot.online ? 'В сети' : 'Не в сети') : 'Проверяем связь'} online={session.data?.snapshot.online} />}>
    <div className="control-toolbar"><span className={'presence' + (session.data?.snapshot.online ? ' online' : '')}>{session.data ? (session.data.snapshot.online ? 'В сети' : 'Не в сети') : 'Проверяем связь'}</span><div className="control-actions">
      {specs.some(spec => spec.writable) && <ControlApply count={drafts.count} invalid={drafts.invalid} disabled={session.busy || editingBusy || !session.readOK} onApply={() => void drafts.apply(changes => session.execute(async () => {
        const commands = cloudBatchCommands(changes.map(change => ({spec:change.spec,value:change.value!})), session.data!.definitions, session.data!.snapshot.status);
        const result = await api.sendDeviceCommands(device.id, provider, commands);
        if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
        return {text:'Команда принята.'};
      }))} />}
    </div></div>
    <details className="status-details"><summary>О показаниях</summary>
    <p className="help">{specs.some(spec => spec.writable) ? 'Облачный снимок состояния. Принятие команды не подтверждает изменение устройства; облако может вернуть прежнее показание.' : 'Последнее известное состояние в облаке. Обновите статус для получения нового снимка.'}</p>
    {session.data && <p className="help">Снимок получен: {new Date(session.data.fetchedAt).toLocaleString('ru-RU')}</p>}
    {provider === 'sharing' && session.data && <p className="help">{session.data.snapshot.event_stream_connected ? 'Приём отчётов устройства подключён. Новые состояния появляются автоматически.' : 'Свежих отчётов пока нет или соединение ещё устанавливается. Сохранённый снимок Tuya может запаздывать.'}</p>}
    </details>
    {session.data && !session.data.snapshot.online && <p className="saved-summary">Tuya сообщает, что устройство не в сети. Можно обновить статус или отправить команду; результат покажет сервис.</p>}
    {primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} primary onAuthError={onAuthError} />}
    {basic.length > 0 && <div className={"capability-grid" + (basic.every(spec => !spec.writable) ? " sensor-grid" : "")}>{basic.filter(spec => !pairedTimers.has(spec.key)).map(basicField)}</div>}
    {settings.length > 0 && <details className="cloud-properties additional-settings"><summary>Дополнительные настройки</summary><div className="capability-grid">{settings.map(spec => field(spec))}</div></details>}
    {schedules.length > 0 && <section className="light-schedules" aria-label="Расписания света"><h3>Расписания света</h3><div className="capability-grid">{schedules.map(spec => field(spec))}</div></section>}
    {effects.length > 0 && <section className="light-schedules" aria-label="Световые эффекты"><h3>Световые эффекты</h3><div className="capability-grid">{effects.map(spec => field(spec))}</div></section>}
    {advanced.length > 0 && <details className="cloud-properties advanced-controls"><summary>Эффекты и дополнительные параметры</summary>
      <p className="help">Составные команды и параметры производителя. Здесь нужны значения в формате устройства; основные настройки света доступны выше.</p>
      <div className="capability-grid">{advanced.map(spec => field(spec))}</div>
    </details>}
    {session.data && !specs.length && <p className="empty-state">Устройство не предоставило показаний или возможностей управления.</p>}
    {!primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} onAuthError={onAuthError} />}
    <DeviceNetwork api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} />
    {session.data && <details className="cloud-properties"><summary>Свойства устройства</summary><dl>
      <div><dt>ID устройства</dt><dd><code>{device.id}</code></dd></div>
      <div><dt>Тип</dt><dd>{device.category === 'pir' ? 'Датчик движения' : device.category === 'dj' ? 'Лампа' : device.category || 'Не указан'}</dd></div>
      <div><dt>Подключение</dt><dd>{connectionLabel({route:provider,throughGateway:device.sub,localTransport})}</dd></div>
      <div><dt>Управление</dt><dd>{session.data.definitions.functions.length ? 'Через Tuya' : 'Только просмотр показаний'}</dd></div>
    </dl></details>}
    {session.data && <details className="cloud-properties"><summary>Технические данные для настройки связей</summary>
      <p className="help">Коды параметров и известные номера DP для сопоставления устройств. Номер DP не нужен для облачной команды; его отсутствие не означает ошибку. Эти сведения не подтверждают физическое выполнение команды.</p>
      <ul>{[...session.data.definitions.functions,...(session.data.definitions.status_range || [])].filter((spec,index,all) => all.findIndex(s => s.code === spec.code) === index).map(spec => <li key={spec.code}><strong>{specs.find(control => control.key === spec.code)?.label || spec.code}</strong> · <code>{spec.code}</code> · {spec.type}{spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : spec.dp_id ? ' · DP '+spec.dp_id : ''}</li>)}</ul>
    {definitions && <DeviceMappings api={api} device={device} devices={devices} provider={provider} definitions={definitions} disabled={session.busy || labelBusy || aliasBusy} onBusy={setMappingBusy} onAuthError={onAuthError} />}
    </details>}
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
