import { t } from "../i18n";
import type { DeviceRoute } from '../devices';
import { routeLabel } from '../devices';

type ConnectionDetails = { route: DeviceRoute; throughGateway?: boolean; localTransport?: 'wifi' | 'zigbee'; room?: string };

export function connectionLabel({ route, throughGateway, localTransport }: ConnectionDetails) {
  const local = localTransport === 'zigbee' ? t("Через шлюз") : localTransport === 'wifi' ? 'Wi-Fi' : t("Подключение не указано");
  return route === 'local' ? local : throughGateway === true ? t("Через шлюз") : throughGateway === false ? t("Прямое подключение") : local;
}

export function DeviceConnectionSummary(props: ConnectionDetails & { status: string; online?: boolean }) {
  return <section className="device-connection-summary" aria-label={t("Подключение устройства")}><dl>
    <div><dt>{t("Комната")}</dt><dd>{props.room || t("Без комнаты")}</dd></div>
    <div><dt>{t("Подключение")}</dt><dd>{connectionLabel(props)}</dd></div>
    <div><dt>{t("Управление")}</dt><dd>{routeLabel[props.route]}</dd></div>
    <div><dt>{t("Состояние связи")}</dt><dd className={'presence' + (props.online ? ' online' : '')}>{props.status}</dd></div>
  </dl></section>;
}

export function DeviceConnectionDescription(props: ConnectionDetails) {
  const { route, room, throughGateway, localTransport } = props;
  const gateway = route === 'local' || throughGateway === undefined ? localTransport === 'zigbee' : throughGateway;
  const known = route === 'local' ? !!localTransport : throughGateway !== undefined || !!localTransport;
  return <dl className="connection-description">
    <div><dt>{room || t("Комната")}</dt><dd>{room === t("Без комнаты") ? t("Комната для устройства пока не назначена.") : t("Комната — размещение устройства в приложении. Она помогает группировать и находить устройства.")}</dd></div>
    <div><dt>{connectionLabel(props)}</dt><dd>{!known ? t("Сервис пока не получил сведения о подключении устройства.") : gateway ? t("Устройство подключено через шлюз: шлюз передаёт ему команды и принимает его показания. Подпись «Через шлюз» сама по себе не уточняет протокол связи устройства со шлюзом.") : route === 'local' || throughGateway === undefined ? t("Сервис подключается к устройству по Wi-Fi в домашней сети.") : t("В данных Tuya устройство отмечено как самостоятельное, без родительского шлюза. Команды доставляются выбранным способом управления.")}</dd></div>
    <div><dt>{routeLabel[route]}</dt><dd>{route === 'local' ? t("Браузер передаёт команду нашему сервису, а сервис — {0}. Для управления сервис должен иметь доступ к этой сети.", [gateway ? t('настроенному шлюзу в домашней сети, который передаёт её устройству') : t('устройству в домашней сети')]) : t("Браузер передаёт команду нашему сервису, сервис — в облако Tuya через подключённый аккаунт {0}. Облако доставляет её устройству или его шлюзу. Для этого способа управления нужен интернет.", [route === 'sharing' ? 'Smart Life' : 'Tuya Developer'])}</dd></div>
    <div><dt>{t("Состояние связи")}</dt><dd>{route === 'local' ? t("Доступность в домашней сети определяется последним обращением сервиса к устройству или шлюзу.") : t("«В сети» и «Не в сети» — последний известный статус из Tuya. Облачные данные могут обновляться с задержкой.")}{" " + t("Принятие команды и новое показание устройства отображаются отдельно.")}</dd></div>
  </dl>;
}
