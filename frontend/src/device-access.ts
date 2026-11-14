export type DeviceInternet = {available:boolean;blocked:boolean|null;verified:boolean;reason?:'not_registered'|'service_unavailable'|'no_endpoint'};
export type DeviceAccess = {control:'local'|'remote'|'unavailable';host:string|null;mac:string|null;'local_available':boolean;internet:DeviceInternet};
