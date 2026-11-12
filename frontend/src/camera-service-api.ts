import { CloudApi } from './api';
import type { Provider } from './api';
import type { CameraPlayback } from './camera-stream';

export type LocalCamera = {
  id:string; 'name':string; host:string; connected:boolean; model?:string; firmware?:string;
  'device_id'?:string; profile?:string; profiles?:{token:string;codec:string|null}[];
  protocol?:string;
};
export type CameraConnectionInput = {
  'device_id'?:string; username:string; password:string; profile?:string; transcode:boolean;
};

export class CameraServiceApi extends CloudApi {
  override cameraStream(id:string, provider:Provider, signal?:AbortSignal) {
    if (id.startsWith('local-camera:')) {
      const cameraId = encodeURIComponent(id.slice('local-camera:'.length));
      return this.request<CameraPlayback>(`/cameras/${cameraId}/playback`, 'POST', {}, signal);
    }
    return super.cameraStream(id, provider, signal);
  }

  cameraServiceStatus() { return this.request<{configured:boolean}>('/cameras/service'); }

  localCameras() { return this.request<LocalCamera[]>('/cameras'); }

  discoverCameras() { return this.request<LocalCamera[]>('/cameras/discovery', 'POST', {}); }

  connectLocalCamera(id:string, body:CameraConnectionInput) {
    return this.request<LocalCamera>(`/cameras/${encodeURIComponent(id)}/connection`, 'PUT', body);
  }

  disconnectLocalCamera(id:string) { return this.request(`/cameras/${encodeURIComponent(id)}/connection`, 'DELETE'); }
}
