export type CameraPlayback = {'device_id':string; type:'hls'|'webrtc'; url:string; transport?:'local'|'cloud'; 'server_url'?:string};

export function cameraPlaybackUrl(value:CameraPlayback, deviceId:string, baseUrl:string) {
  const url = new URL(value.url, baseUrl);
  const legacy = /^\/api\/v1\/camera\/play\/[A-Za-z0-9_-]{43}\/index\.m3u8$/;
  const path = value.type === 'hls' ? /^\/play\/hls\/[A-Za-z0-9_-]{43}\/index\.m3u8$/ : /^\/play\/native\/[A-Za-z0-9_-]{43}\/ws$/;
  if (value.device_id !== deviceId || !['hls', 'webrtc'].includes(value.type)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !(path.test(url.pathname) || (value.type === 'hls' && legacy.test(url.pathname)))) throw new Error('Invalid camera playback');
  return url.href;
}

export function connectCameraWebRTC(video:HTMLVideoElement, source:string, fail:()=>void, speed:(value:number)=>void) {
  const element = video;
  const peer = new RTCPeerConnection({ iceServers: [] });
  const remote = new MediaStream();
  const target = new URL(source);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(target);
  let closed = false; let offered = false; let
    answered = false;
  const candidates:string[] = []; const
    incoming:string[] = [];
  let previous:{bytes:number; timestamp:number}|undefined;
  const failed = () => { if (!closed) fail(); };
  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.addTransceiver('audio', { direction: 'recvonly' });
  peer.ontrack = (event) => { remote.addTrack(event.track); element.srcObject = remote; element.play().catch(() => {}); };
  peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') failed(); };
  peer.onicecandidate = (event) => {
    if (!event.candidate || closed) return;
    if (offered) socket.send(JSON.stringify({ type: 'webrtc/candidate', value: event.candidate.candidate }));
    else candidates.push(event.candidate.candidate);
  };
  socket.onopen = () => {
    (async () => {
      const offer = await peer.createOffer();
      if (closed) return;
      await peer.setLocalDescription(offer);
      if (closed) return;
      socket.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp }));
      offered = true;
      candidates.splice(0).forEach((value) => socket.send(JSON.stringify({ type: 'webrtc/candidate', value })));
    })().catch(failed);
  };
  socket.onmessage = (event) => {
    (async () => {
      if (closed) return;
      const message = JSON.parse(event.data) as {type:string;value:string};
      if (message.type === 'error') { failed(); return; }
      if (message.type === 'webrtc/answer') {
        await peer.setRemoteDescription({ type: 'answer', sdp: message.value });
        answered = true;
        incoming.splice(0).forEach((candidate) => { peer.addIceCandidate({ candidate, sdpMid: '0' }).catch(failed); });
      } else if (message.type === 'webrtc/candidate') {
        if (answered) await peer.addIceCandidate({ candidate: message.value, sdpMid: '0' });
        else incoming.push(message.value);
      }
    })().catch(failed);
  };
  socket.onerror = failed;
  socket.onclose = failed;
  const timer = window.setInterval(() => {
    peer.getStats().then((stats) => {
      if (closed) return;
      stats.forEach((row) => {
        if (row.type !== 'inbound-rtp' || row.kind !== 'video' || !Number.isFinite(row.bytesReceived)) return;
        if (previous && row.timestamp > previous.timestamp) speed(Math.round((row.bytesReceived - previous.bytes) / (row.timestamp - previous.timestamp)));
        previous = { bytes: row.bytesReceived as number, timestamp: row.timestamp as number };
      });
    }).catch(() => {});
  }, 2000);
  return () => {
    closed = true;
    window.clearInterval(timer);
    socket.close(); peer.close();
    remote.getTracks().forEach((track) => track.stop());
    element.srcObject = null;
  };
}
