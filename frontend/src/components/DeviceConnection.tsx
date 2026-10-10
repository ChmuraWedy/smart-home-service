import type { DeviceRoute } from '../devices';
import { routeLabel } from '../devices';

type ConnectionDetails = { route: DeviceRoute; throughGateway?: boolean; localTransport?: 'wifi' | 'zigbee'; room?: string };

export function connectionLabel({ route, throughGateway, localTransport }: ConnectionDetails) {
  const local = localTransport === 'zigbee' ? 'Через шлюз' : localTransport === 'wifi' ? 'Wi-Fi' : 'Подключение не указано';
  return route === 'local' ? local : throughGateway === true ? 'Через шлюз' : throughGateway === false ? 'Прямое подключение' : local;
}

export function DeviceConnectionSummary(props: ConnectionDetails & { status: string; online?: boolean }) {
  return <section className="device-connection-summary" aria-label="Подключение устройства"><dl>
    <div><dt>Комната</dt><dd>{props.room || 'Без комнаты'}</dd></div>
    <div><dt>Подключение</dt><dd>{connectionLabel(props)}</dd></div>
    <div><dt>Управление</dt><dd>{routeLabel[props.route]}</dd></div>
    <div><dt>Состояние связи</dt><dd className={'presence' + (props.online ? ' online' : '')}>{props.status}</dd></div>
  </dl></section>;
}

export function DeviceConnectionDescription(props: ConnectionDetails) {
  const { route, room, throughGateway, localTransport } = props;
  const gateway = route === 'local' || throughGateway === undefined ? localTransport === 'zigbee' : throughGateway;
  const known = route === 'local' ? !!localTransport : throughGateway !== undefined || !!localTransport;
  return <dl className="connection-description">
    <div><dt>{room || 'Комната'}</dt><dd>{room === 'Без комнаты' ? 'Комната для устройства пока не назначена.' : 'Комната — размещение устройства в приложении. Она помогает группировать и находить устройства.'}</dd></div>
    <div><dt>{connectionLabel(props)}</dt><dd>{!known ? 'Сервис пока не получил сведения о подключении устройства.' : gateway ? 'Устройство подключено через шлюз: шлюз передаёт ему команды и принимает его показания. Подпись «Через шлюз» сама по себе не уточняет протокол связи устройства со шлюзом.' : route === 'local' || throughGateway === undefined ? 'Сервис подключается к устройству по Wi-Fi в домашней сети.' : 'В данных Tuya устройство отмечено как самостоятельное, без родительского шлюза. Команды доставляются выбранным способом управления.'}</dd></div>
    <div><dt>{routeLabel[route]}</dt><dd>{route === 'local' ? `Браузер передаёт команду нашему сервису, а сервис — ${gateway ? 'настроенному шлюзу в домашней сети, который передаёт её устройству' : 'устройству в домашней сети'}. Для управления сервис должен иметь доступ к этой сети.` : `Браузер передаёт команду нашему сервису, сервис — в облако Tuya через подключённый аккаунт ${route === 'sharing' ? 'Smart Life' : 'Tuya Developer'}. Облако доставляет её устройству или его шлюзу. Для этого способа управления нужен интернет.`}</dd></div>
    <div><dt>Состояние связи</dt><dd>{route === 'local' ? 'Доступность в домашней сети определяется последним обращением сервиса к устройству или шлюзу.' : '«В сети» и «Не в сети» — последний известный статус из Tuya. Облачные данные могут обновляться с задержкой.'} Принятие команды и новое показание устройства отображаются отдельно.</dd></div>
  </dl>;
}
