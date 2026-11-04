import { dateLocale, t } from "../i18n";
import { useCallback, useMemo, useState } from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, CloudSnapshot, JsonValue, Provider } from '../api';
import { cloudBatchCommands, cloudCommands, cloudReading, cloudSpecs, displayReading, withChannelLabels } from '../controls';
import type { ControlSpec } from '../controls';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceMappings } from './DeviceMappings';
import { ChannelAliases } from './ChannelAliases';
import { DeviceNetwork } from './DeviceNetwork';
import { useAutomaticControls } from '../control-drafts';
import { DeviceAliases } from './DeviceAliases';
import { BatteryBadge, batteryFromSpecs, isBattery, isCamera } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { connectionLabel, DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';
import { hasLightEffectWizard } from './LightEffectWizard';
import { hasScheduleWizard } from './ScheduleWizard';
import { ChannelControl, channelTimer } from './ChannelControl';
import type { ReactNode } from 'react';
import { CameraLive } from './CameraLive';
import { CameraSettings } from './CameraSettings';
import { CameraFormat } from './CameraFormat';
import { FieldInfo } from './FieldInfo';
import { cameraStorage, isStorageSetting, cameraPrivacyBlock } from '../camera-controls';
import { CameraArea } from './CameraArea';

export function CloudControl({ api, device, provider, devices, room, localTransport, onClose, onAuthError }: {
  api: CloudApi; device: CloudDevice; provider: Provider; devices?: CloudDevice[]; room?: string; localTransport?: 'wifi' | 'zigbee'; onClose: () => void; onAuthError: () => void;
}) {
  const [privacyState,setPrivacyState] = useState<boolean | null | undefined>();
  const [mappingBusy,setMappingBusy] = useState(false);
  const [aliasBusy, setAliasBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false), [labels, setLabels] = useState<Record<string, string> | null>(null);
  const editingBusy = mappingBusy || labelBusy || aliasBusy;
  const metadata = useMemo(() => ({value:null as CloudFunctions|null}),[api,device.id,provider]);
  const checked = (snapshot:CloudSnapshot) => {
    if (snapshot.device_id !== device.id || !snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) throw new Error(t("Сервис вернул неожиданные данные устройства."));
    return snapshot;
  };
  const receiptTime = (snapshot:CloudSnapshot) => snapshot.snapshot_received_at && Number.isFinite(Date.parse(snapshot.snapshot_received_at)) ? Date.parse(snapshot.snapshot_received_at) : Date.now();
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const [definitions, snapshot] = await Promise.all([metadata.value ? Promise.resolve(metadata.value) : api.deviceFunctions(device.id, provider, signal), api.deviceSnapshot(device.id, provider, signal)]);
    if (definitions.device_id !== device.id || snapshot.device_id !== device.id || !Array.isArray(definitions.functions) || !snapshot.status || typeof snapshot.status !== 'object') throw new Error(t("Сервис вернул неожиданные данные устройства."));
    if (!signal?.aborted) metadata.value = definitions;
    return { definitions, snapshot:checked(snapshot), fetchedAt: receiptTime(snapshot) };
  }, [api, device.id, provider,metadata]);
  type Data = { definitions: CloudFunctions; snapshot: CloudSnapshot; fetchedAt: number };
  const poll = useCallback(async (current:Data, signal:AbortSignal) => {
    const snapshot = checked(await api.deviceSnapshot(device.id,provider,signal,false));
    return {...current,snapshot,fetchedAt:snapshot.snapshot_received_at ? receiptTime(snapshot) : current.fetchedAt};
  },[api,device.id,provider]);
  const session = useControlSession<Data>(load, onAuthError, provider === 'sharing' && !editingBusy ? poll : undefined);
  const now = useClock();
  const definitions = session.data ? labels ? withChannelLabels(session.data.definitions, labels) : session.data.definitions : null;
  const specs = session.data && definitions ? cloudSpecs(definitions, session.data.snapshot) : [];
  const camera = isCamera(device.category);
  const storage = cameraStorage(session.data?.snapshot.status || {});
  const privacy = camera ? specs.find(spec=>spec.key==='basic_private' && spec.writable && spec.kind==='boolean') : undefined;
  const privacyBlock = cameraPrivacyBlock(privacyState === undefined ? (typeof session.data?.snapshot.status.basic_private === 'boolean' ? session.data.snapshot.status.basic_private : privacy ? null : undefined) : privacyState);
  const regularSpecs = camera ? [] : specs;
  const settings = regularSpecs.filter(spec => /^(relay_status(?:_[1-9][0-9]*)?|switch_backlight|switch_inching)$/.test(spec.key));
  const basic = regularSpecs.filter(spec => !spec.advanced && !hasLightEffectWizard(spec) && !settings.includes(spec) && !isBattery(spec.key)), schedules = regularSpecs.filter(hasScheduleWizard), effects = regularSpecs.filter(hasLightEffectWizard), advanced = regularSpecs.filter(spec => spec.advanced && !settings.includes(spec) && !hasScheduleWizard(spec) && !hasLightEffectWizard(spec));
  const ensureStorage = (spec:ControlSpec) => {if (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready)) throw new Error(storage.label+t(". Команда недоступна."));};
  const sendValue = (spec:ControlSpec,value:JsonValue) => session.execute(async () => {
    ensureStorage(spec);
    const result = await api.sendDeviceCommands(device.id, provider, cloudCommands(spec, value, session.data!.definitions));
    if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
    return { text: t("Команда принята.") };
  });
  const drafts = useAutomaticControls(changes => session.execute(async () => {
    changes.forEach(change => ensureStorage(change.spec));
    const commands = cloudBatchCommands(changes.map(change => ({spec:change.spec,value:change.value!})), session.data!.definitions, session.data!.snapshot.status);
    const result = await api.sendDeviceCommands(device.id, provider, commands);
    if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
    return {text:t("Команда принята.")};
  }), !session.busy && !editingBusy && session.readOK);
  const field = (spec: ControlSpec, headingActions?: ReactNode) => {
    const info = camera && spec.help;
    const helpIcon = info ? <FieldInfo label={spec.label} text={info} /> : undefined;
    const disabled = editingBusy || session.busy || !session.readOK || (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready));
    if (camera && spec.key==='record_switch' && !storage.ready) return <section className="capability camera-record-unavailable" key={spec.key} aria-label={spec.label}><div className="capability-row"><div className="capability-heading"><div className="capability-label-line"><h3>{spec.label}</h3>{helpIcon}</div></div><span>{t("Недоступна")}</span></div><p className="help">{storage.label}. {session.data?.snapshot.status.record_switch===true ? t("Сохранённая настройка записи включена, но это не означает, что камера записывает видео.") : t("Запись станет доступна после установки исправной карты памяти.")}</p></section>;
    if (camera && spec.key === 'sd_format' && spec.writable && spec.kind === 'boolean') return <CameraFormat key={spec.key} information={helpIcon} disabled={disabled} onFormat={()=>sendValue(spec,true)} />;
    const privacyButton = camera && spec.key === 'basic_private' && spec.writable && spec.kind === 'boolean';
    return <CapabilityField headingActions={info ? <>{headingActions}{helpIcon}</> : headingActions} key={spec.key} spec={info || privacyButton ? {...spec,help:undefined} : spec} valueEditor={camera && spec.key==='motion_area' && ['text','json'].includes(spec.kind) ? (value,change)=><CameraArea viewingBlocked={privacyBlock} value={value} onChange={change} disabled={disabled} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} /> : undefined} stage={spec.kind === 'boolean' ? undefined : drafts.stage} immediatePower booleanButton={privacyButton} buttonText={privacyButton ? value=>value===null ? t("Нет данных") : value ? t("Включена") : t("Выключена") : undefined} onBooleanStateChange={privacyButton ? setPrivacyState : undefined} reading={camera && spec.key==='sd_status' ? {...cloudReading(spec,session.data!.snapshot.status[spec.key],session.data!.snapshot.status_observations?.[spec.key]),value:storage.label} : cloudReading(spec, session.data!.snapshot.status[spec.key], session.data!.snapshot.status_observations?.[spec.key])} now={now} local={false} onRefresh={session.refresh} aliasEditor={/^switch_[1-9][0-9]*$/.test(spec.key) ? <ChannelAliases api={api} deviceId={device.id} provider={provider} code={spec.key} alias={spec.aliases?.[0]} disabled={session.busy || mappingBusy || aliasBusy || labelBusy} onBusy={setLabelBusy} onSaved={setLabels} onAuthError={onAuthError} /> : undefined} disabled={disabled} onSend={value=>sendValue(spec,value)} />;
  };
  const pairedTimers = new Set(basic.flatMap(spec => { const timer = channelTimer(spec,basic); return timer ? [timer.key] : []; }));
  const basicField = (spec:ControlSpec) => <ChannelControl key={spec.key} spec={spec} timer={channelTimer(spec,basic)} renderField={field} />;
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  const signal = specs.find(spec => ['wifi_signal','signal_strength','rssi'].includes(spec.key) && spec.readable && spec.kind === 'number');
  const networkSignal = signal && session.data ? displayReading(signal,cloudReading(signal,session.data.snapshot.status[signal.key])) : undefined;
  return <ControlDialog onRefresh={session.refresh} information={<DeviceConnectionDescription room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} />} statusContent={<BatteryBadge reading={session.data ? batteryFromSpecs(specs,session.data.snapshot.status) : device.battery} />} className={camera ? 'camera-controls' : device.category === 'dj' || specs.some(spec => spec.kind === 'color') ? 'bulb-controls' : ''} title={device.name || t("Устройство Tuya")} busy={session.busy || editingBusy} onClose={onClose} titleContent={<DeviceAliases api={api} deviceId={device.id} name={device.name} initialAliases={device.aliases} provider={provider} disabled={session.busy || mappingBusy || labelBusy} onBusy={setAliasBusy} onAuthError={onAuthError} />} connectionContent={<DeviceConnectionSummary room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} status={session.data ? (session.data.snapshot.online ? t("В сети") : t("Не в сети")) : t("Проверяем связь")} online={session.data?.snapshot.online} />}>
    {camera && <CameraLive key={device.id + provider} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} networkSignal={networkSignal} viewingBlocked={privacyBlock} headingActions={privacy ? <div className="camera-header-privacy">{field(privacy)}</div> : undefined} />}
    <div className="control-toolbar"><span className={'presence' + (session.data?.snapshot.online ? ' online' : '')}>{session.data ? (session.data.snapshot.online ? t("В сети") : t("Не в сети")) : t("Проверяем связь")}</span></div>
    <details className="status-details"><summary>{t("О показаниях")}</summary>
    <p className="help">{specs.some(spec => spec.writable) ? t("Облачный снимок состояния. Принятие команды не подтверждает изменение устройства; облако может вернуть прежнее показание.") : t("Последнее известное состояние в облаке. Обновите статус для получения нового снимка.")}</p>
    {session.data && <p className="help">{t("Снимок получен:") + " "}{new Date(session.data.fetchedAt).toLocaleString(dateLocale())}</p>}
    {provider === 'sharing' && session.data && <p className="help">{session.data.snapshot.event_stream_connected ? t("Приём отчётов устройства подключён. Новые состояния появляются автоматически.") : t("Свежих отчётов пока нет или соединение ещё устанавливается. Сохранённый снимок Tuya может запаздывать.")}</p>}
    </details>
    {session.data && !session.data.snapshot.online && <p className="saved-summary">{t("Tuya сообщает, что устройство не в сети. Можно обновить статус или отправить команду; результат покажет сервис.")}</p>}
    {primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} primary onAuthError={onAuthError} />}
    {camera && <CameraSettings specs={specs.filter(spec => !isBattery(spec.key) && spec!==privacy)} renderField={field} />}
    {basic.length > 0 && <div className={"capability-grid" + (basic.every(spec => !spec.writable) ? " sensor-grid" : "")}>{basic.filter(spec => !pairedTimers.has(spec.key)).map(basicField)}</div>}
    {settings.length > 0 && <details className="cloud-properties additional-settings"><summary>{t("Дополнительные настройки")}</summary><div className="capability-grid">{settings.map(spec => field(spec))}</div></details>}
    {schedules.length > 0 && <section className="light-schedules" aria-label={t("Расписания света")}><h3>{t("Расписания света")}</h3><div className="capability-grid">{schedules.map(spec => field(spec))}</div></section>}
    {effects.length > 0 && <section className="light-schedules" aria-label={t("Световые эффекты")}><h3>{t("Световые эффекты")}</h3><div className="capability-grid">{effects.map(spec => field(spec))}</div></section>}
    {advanced.length > 0 && <details className="cloud-properties advanced-controls"><summary>{t("Эффекты и дополнительные параметры")}</summary>
      <p className="help">{t("Составные команды и параметры производителя. Здесь нужны значения в формате устройства; основные настройки света доступны выше.")}</p>
      <div className="capability-grid">{advanced.map(spec => field(spec))}</div>
    </details>}
    {session.data && !specs.length && <p className="empty-state">{t("Устройство не предоставило показаний или возможностей управления.")}</p>}
    {!primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} onAuthError={onAuthError} />}
    <DeviceNetwork api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} />
    {session.data && <details className="cloud-properties"><summary>{t("Свойства устройства")}</summary><dl>
      <div><dt>{t("ID устройства")}</dt><dd><code>{device.id}</code></dd></div>
      <div><dt>{t("Тип")}</dt><dd>{isCamera(device.category) ? t("Камера") : device.category === 'pir' ? t("Датчик движения") : device.category === 'dj' ? t("Лампа") : device.category || t("Не указан")}</dd></div>
      <div><dt>{t("Подключение")}</dt><dd>{connectionLabel({route:provider,throughGateway:device.sub,localTransport})}</dd></div>
      <div><dt>{t("Управление")}</dt><dd>{session.data.definitions.functions.length ? t("Через Tuya") : t("Только просмотр показаний")}</dd></div>
    </dl></details>}
    {session.data && <details className="cloud-properties"><summary>{t("Технические данные для настройки связей")}</summary>
      <p className="help">{t("Коды параметров и известные номера DP для сопоставления устройств. Номер DP не нужен для облачной команды; его отсутствие не означает ошибку. Эти сведения не подтверждают физическое выполнение команды.")}</p>
      <ul>{[...session.data.definitions.functions,...(session.data.definitions.status_range || [])].filter((spec,index,all) => all.findIndex(s => s.code === spec.code) === index).map(spec => <li key={spec.code}><strong>{specs.find(control => control.key === spec.code)?.label || spec.code}</strong> · <code>{spec.code}</code> · {spec.type}{spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : spec.dp_id ? ' · DP '+spec.dp_id : ''}</li>)}</ul>
    {definitions && <DeviceMappings api={api} device={device} devices={devices} provider={provider} definitions={definitions} disabled={session.busy || labelBusy || aliasBusy} onBusy={setMappingBusy} onAuthError={onAuthError} />}
    </details>}
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
