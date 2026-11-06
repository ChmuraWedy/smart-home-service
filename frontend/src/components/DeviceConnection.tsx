import { MSG, t } from "../i18n";
import type { DeviceRoute } from '../devices';
import { routeLabel } from '../devices';

type ConnectionDetails = { route: DeviceRoute; throughGateway?: boolean; localTransport?: 'wifi' | 'zigbee'; room?: string };

export function connectionLabel({ route, throughGateway, localTransport }: ConnectionDetails) {
  const local = localTransport === 'zigbee' ? t(MSG.VIA_GATEWAY) : localTransport === 'wifi' ? 'Wi-Fi' : t(MSG.CONNECTION_NOT_SPECIFIED);
  return route === 'local' ? local : throughGateway === true ? t(MSG.VIA_GATEWAY) : throughGateway === false ? t(MSG.DIRECT_CONNECTION) : local;
}

export function DeviceConnectionSummary(props: ConnectionDetails & { status: string; online?: boolean }) {
  return <section className="device-connection-summary" aria-label={t(MSG.DEVICE_CONNECTION)}><dl>
    <div><dt>{t(MSG.ROOM)}</dt><dd>{props.room || t(MSG.NO_ROOM)}</dd></div>
    <div><dt>{t(MSG.CONNECTION)}</dt><dd>{connectionLabel(props)}</dd></div>
    <div><dt>{t(MSG.CONTROL)}</dt><dd>{routeLabel[props.route]}</dd></div>
    <div><dt>{t(MSG.CONNECTION_STATUS)}</dt><dd className={'presence' + (props.online ? ' online' : '')}>{props.status}</dd></div>
  </dl></section>;
}

export function DeviceConnectionDescription(props: ConnectionDetails) {
  const { route, room, throughGateway, localTransport } = props;
  const gateway = route === 'local' || throughGateway === undefined ? localTransport === 'zigbee' : throughGateway;
  const known = route === 'local' ? !!localTransport : throughGateway !== undefined || !!localTransport;
  return <dl className="connection-description">
    <div><dt>{room || t(MSG.ROOM)}</dt><dd>{room === t(MSG.NO_ROOM) ? t(MSG.NO_ROOM_HAS_BEEN_ASSIGNED_TO_THIS_DEVICE) : t(MSG.THE_ROOM_IS_THE_DEVICES_LOCATION_IN_THIS)}</dd></div>
    <div><dt>{connectionLabel(props)}</dt><dd>{!known ? t(MSG.THE_SERVICE_HAS_NOT_RECEIVED_CONNECTION_DETAILS_FOR) : gateway ? t(MSG.THIS_DEVICE_CONNECTS_THROUGH_A_GATEWAY_WHICH_FORWARDS) : route === 'local' || throughGateway === undefined ? t(MSG.THE_SERVICE_CONNECTS_TO_THIS_DEVICE_OVER_WIFI) : t(MSG.TUYA_IDENTIFIES_THIS_AS_AN_INDEPENDENT_DEVICE_WITHOUT)}</dd></div>
    <div><dt>{routeLabel[route]}</dt><dd>{route === 'local' ? t(MSG.LOCAL_COMMAND_ROUTE_HELP, [gateway ? t(MSG.THE_CONFIGURED_GATEWAY_ON_YOUR_HOME_NETWORK_WHICH) : t(MSG.THE_DEVICE_ON_YOUR_HOME_NETWORK)]) : t(MSG.CLOUD_COMMAND_ROUTE_HELP, [route === 'sharing' ? 'Smart Life' : 'Tuya Developer'])}</dd></div>
    <div><dt>{t(MSG.CONNECTION_STATUS)}</dt><dd>{route === 'local' ? t(MSG.LOCAL_AVAILABILITY_IS_BASED_ON_THE_SERVICES_LAST) : t(MSG.ONLINE_AND_OFFLINE_ARE_THE_LAST_KNOWN_TUYA)}{" " + t(MSG.COMMAND_ACKNOWLEDGEMENT_AND_NEW_DEVICE_READINGS_ARE_DISPLAYED)}{route === 'local' && <p>{t(MSG.WHILE_THE_CARD_IS_VISIBLE_THE_SERVER_REQUESTS)}</p>}</dd></div>
  </dl>;
}
