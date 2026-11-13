export type DeviceInternet = {available:boolean;blocked:boolean|null;verified:boolean};
export type DeviceAccess = {control:'local'|'remote';host:string|null;mac:string|null;'local_available':boolean;internet:DeviceInternet};
