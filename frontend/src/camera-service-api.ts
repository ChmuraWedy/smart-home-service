import { CloudApi } from './api';

export type LocalCamera = {
  id:string; 'name':string; host:string; connected:boolean; model?:string; firmware?:string;
  'device_id'?:string; profile?:string; profiles?:{token:string;codec:string|null}[];
  protocol?:string; 'controls_available'?:boolean;
};
export type CameraControls = {
  transport:'local'; 'observed_at':number; confirmed:boolean|null; 'stop_sent'?:boolean;
  state:Record<string, boolean|number|string>;
  functions:Record<string, {'dp_id':number;type:'Boolean'|'Enum'|'Integer';values:{range?:string[];min?:number;max?:number;step?:number}}>;
};
export type CameraConnectionInput = {
  'device_id'?:string; username:string; password:string; profile?:string; transcode:boolean;
};

export class CameraServiceApi extends CloudApi {
  cameraServiceStatus() { return this.request<{configured:boolean}>('/cameras/service'); }

  discoverCameras() { return this.request<LocalCamera[]>('/cameras/discovery', 'POST', {}); }

  connectLocalCamera(id:string, body:CameraConnectionInput) {
    return this.request<LocalCamera>(`/cameras/${encodeURIComponent(id)}/connection`, 'PUT', body);
  }

  disconnectLocalCamera(id:string) { return this.request(`/cameras/${encodeURIComponent(id)}/connection`, 'DELETE'); }
}
