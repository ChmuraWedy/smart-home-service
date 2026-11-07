import type { CloudApi, CloudDevice, NetworkObservation } from '../api';
import type { DeviceRoute } from '../devices';
import { routeLabel } from '../devices';
import type { LocalDevice } from '../home-api';
import { MSG, dateLocale, t } from '../i18n';
import { connectionLabel } from './DeviceConnection';
import { DeviceNetwork } from './DeviceNetwork';
import { isCamera } from './DevicePresentation';

function deviceType(category?: string | null) {
  if (isCamera(category ?? undefined)) return t(MSG.CAMERA);
  if (category === 'pir') return t(MSG.MOTION_SENSOR);
  if (category === 'dj') return t(MSG.LIGHT_BULB);
  return category || t(MSG.NOT_SPECIFIED);
}

export default function DeviceInformation({
  api, deviceId, displayName, route, routes, local, cloud, gateway, writable, onAuthError,
}: {
  api: CloudApi;
  deviceId: string;
  displayName: string;
  route: DeviceRoute;
  routes: DeviceRoute[];
  local?: LocalDevice;
  cloud?: CloudDevice;
  gateway?: LocalDevice;
  writable?: boolean;
  onAuthError: () => void;
}) {
  function facts(network: NetworkObservation | null) {
    const gatewayConnection = local?.transport === 'zigbee' || cloud?.sub === true || Boolean(gateway || cloud?.gateway_id);
    const throughGateway = gatewayConnection || network?.route === 'gateway';
    const connection = connectionLabel({
      route,
      throughGateway: throughGateway || (network?.route === 'direct' ? false : cloud?.sub),
      localTransport: local?.transport,
    });
    const endpoint = throughGateway ? gateway : local;
    const observedEndpoint = network?.route === (throughGateway ? 'gateway' : 'direct')
      && (!endpoint || network.target_id === endpoint.device_id) ? network : undefined;
    const gatewayId = gateway?.device_id ?? (throughGateway ? observedEndpoint?.target_id ?? cloud?.gateway_id : undefined);
    const configuredIp = endpoint?.ip ?? observedEndpoint?.configured_ip;
    const observedIp = observedEndpoint?.observed_ip;
    const knownRoutes = routes.map((item) => routeLabel[item]).join(' · ');
    const category = local?.category || cloud?.category;
    const entries = [
      { label: t(MSG.NAME), value: displayName },
      { label: t(MSG.TUYA_DEVICE_NAME), value: cloud?.name !== displayName ? cloud?.name : undefined },
      { label: t(MSG.DEVICE_ID), value: deviceId, code: true },
      { label: t(MSG.LOCAL_INVENTORY_ID), value: local && String(local.id), code: true },
      { label: t(MSG.TYPE), value: local?.is_gateway ? t(MSG.GATEWAY) : deviceType(category) },
      { label: t(MSG.DEVICE_CATEGORY_CODE), value: category, code: true },
      { label: t(MSG.DEVICE_PRODUCT_ID), value: local?.product_id || cloud?.product_id, code: true },
      { label: t(MSG.CONNECTION), value: connection },
      { label: t(MSG.CONTROL), value: routeLabel[route] },
      { label: t(MSG.AVAILABLE_CONTROL_ROUTES), value: knownRoutes },
      { label: t(MSG.DEVICE_CONTROLS), value: writable === undefined ? undefined : t(writable ? MSG.VIA_TUYA : MSG.READINGS_ONLY) },
      { label: t(MSG.GATEWAY), value: gateway?.name || gatewayId || (throughGateway ? t(MSG.NOT_SET) : undefined) },
      { label: t(MSG.GATEWAY_DEVICE_ID), value: gateway?.name ? gatewayId : undefined, code: true },
      { label: t(MSG.ZIGBEE_NODE_ID), value: local?.cid || cloud?.node_id, code: true },
      { label: t(throughGateway ? MSG.GATEWAY_IP_ADDRESS : MSG.CONFIGURED_IP), value: configuredIp || t(MSG.NOT_SET), code: Boolean(configuredIp) },
      { label: t(throughGateway ? MSG.OBSERVED_GATEWAY_IP : MSG.OBSERVED_IP), value: observedIp, code: true },
      { label: t(MSG.MAC_ADDRESS), value: local?.mac || t(MSG.NOT_SET), code: Boolean(local?.mac) },
      { label: t(MSG.GATEWAY_MAC_ADDRESS), value: throughGateway ? gateway?.mac : undefined, code: true },
      { label: t(MSG.TUYA_PROTOCOL_VERSION), value: endpoint?.version || observedEndpoint?.version },
      { label: t(MSG.LOCAL_CONNECTION), value: local ? t(local.enabled ? MSG.CONNECTION_SAVED : MSG.DISABLED_IN_SETTINGS) : undefined },
      { label: t(MSG.LOCAL_CONTROL_SUPPORTED), value: typeof cloud?.support_local === 'boolean' ? t(cloud.support_local ? MSG.YES : MSG.NO) : undefined },
      { label: t(MSG.LAST_LAN_READING), value: local?.last_seen_at ? new Date(local.last_seen_at).toLocaleString(dateLocale()) : undefined },
      { label: t(MSG.DEVICE_DESCRIPTION), value: local?.description },
    ];
    return (
      <dl className="device-information">
        {entries.filter(({ value }) => value).map(({ label, value, code }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {code ? <code>{value}</code> : value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <DeviceNetwork
      api={api}
      deviceId={deviceId}
      provider={route}
      onAuthError={onAuthError}
      information={(network) => facts(network)}
    />
  );
}
