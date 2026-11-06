import { MSG, t } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError, CloudApi } from '../api';
import type { Provider } from '../api';
import type Hls from 'hls.js';
import type { ReactNode } from 'react';
import { IconGlyph } from './ui/icon';

type VideoLevel = {index:number; width:number; height:number; bitrate:number};
type SafariVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitEnterFullscreen?: () => void;
  webkitSupportsPresentationMode?: (mode: 'picture-in-picture') => boolean;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void;
};

function isFloating(video: SafariVideo) {
  return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';
}

async function closeFloatingVideo(video: SafariVideo) {
  if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
  else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode?.('inline');
}

function resolutionLabel(width:number, height:number) {
  return (Math.min(width,height) >= 720 ? 'HD' : 'SD') + ' · ' + width + '×' + height;
}

export function CameraLive({ api, deviceId, provider, onAuthError, compact = false, sheet = false, autoStart = false, networkSignal, headingActions, overlay, viewingBlocked }: {
  api: CloudApi; deviceId: string; provider: Provider; onAuthError: () => void; compact?: boolean; sheet?:boolean; autoStart?: boolean; networkSignal?: string; headingActions?:ReactNode; overlay?:ReactNode; viewingBlocked?:string;
}) {
  const video = useRef<SafariVideo>(null), pending = useRef<AbortController | null>(null);
  const hls = useRef<Hls | null>(null);
  const [source, setSource] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(t(MSG.VIDEO_STARTS_ONLY_WHEN_YOU_REQUEST_IT));
  const [error, setError] = useState(false);
  const [levels,setLevels] = useState<VideoLevel[]>([]), [selectedLevel,setSelectedLevel] = useState(-1);
  const [resolution,setResolution] = useState(''), [speed,setSpeed] = useState<number | null>(null);
  const [playback,setPlayback] = useState(t(MSG.CONNECTION));
  const [aspect,setAspect] = useState(16/9);
  const [pipMode, setPipMode] = useState<'standard' | 'safari' | null>(null);
  const [pipActive, setPipActive] = useState(false);
  const [pipError, setPipError] = useState(false);
  function resetMetrics() { setLevels([]); setSelectedLevel(-1); setResolution(''); setSpeed(null); setPlayback(t(MSG.CONNECTION)); }
  function stop() {
    pending.current?.abort(); pending.current = null;
    setLoading(false); setSource(null); setError(false); setMessage(t(MSG.PLAYBACK_STOPPED)); resetMetrics();
  }
  useEffect(() => {
    const hide = () => { if (document.hidden && (!video.current || !isFloating(video.current))) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { pending.current?.abort(); pending.current = null; document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    const element = video.current;
    if (viewingBlocked || !source || !element) return;
    setPipMode(null);
    setPipActive(false);
    setPipError(false);
    let active = true, player: Hls | undefined;
    const fail = () => {
      if (!active) return;
      setError(true); setMessage(t(MSG.COULD_NOT_PLAY_THE_VIDEO)); setSource(null); resetMetrics();
    };
    const timeout = window.setTimeout(fail, 45_000);
    const dimensions = () => {
      if (element.videoWidth <= 0 || element.videoHeight <= 0) return;
      setResolution(resolutionLabel(element.videoWidth,element.videoHeight));
      setAspect(element.videoWidth/element.videoHeight);
      if (document.pictureInPictureEnabled && typeof element.requestPictureInPicture === 'function') setPipMode('standard');
      else if (element.webkitSetPresentationMode && element.webkitSupportsPresentationMode?.('picture-in-picture')) setPipMode('safari');
    };
    const presentationChanged = () => {
      const floating = isFloating(element);
      setPipActive(floating);
      setPipError(false);
      if (!floating && document.hidden) stop();
    };
    const presentationEvents = ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged'];
    presentationEvents.forEach(event => element.addEventListener(event, presentationChanged));
    const playing = () => { window.clearTimeout(timeout); setMessage(t(MSG.LIVE)); setPlayback(t(MSG.PLAYING)); dimensions(); };
    const waiting = () => setPlayback(t(MSG.BUFFERING)), paused = () => setPlayback(t(MSG.PAUSED));
    element.addEventListener('playing', playing);
    element.addEventListener('error', fail);
    element.addEventListener('waiting',waiting); element.addEventListener('stalled',waiting);
    element.addEventListener('pause',paused); element.addEventListener('ended',paused);
    element.addEventListener('loadedmetadata',dimensions); element.addEventListener('resize',dimensions);
    const play = () => { void element.play().catch(() => { if (active) setMessage(t(MSG.PRESS_IN_THE_PLAYER_TO_WATCH)); }); };
    void (async () => {
      const { default: HlsPlayer } = await import('hls.js');
      if (!active) return;
      if (!HlsPlayer.isSupported()) {
        if (element.canPlayType('application/vnd.apple.mpegurl')) { element.src = source; play(); return; }
        setError(true); setMessage(t(MSG.THIS_BROWSER_DOES_NOT_SUPPORT_HLS_VIDEO_PLAYBACK)); setSource(null); return;
      }
      player = new HlsPlayer({ debug:false, enableWorker:true, lowLatencyMode:true, backBufferLength:15, maxBufferLength:20 });
      hls.current = player;
      player.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) fail(); });
      player.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
        if (!active || !player) return;
        setLevels(player.levels.map((level,index) => ({index,width:level.width || 0,height:level.height || 0,bitrate:level.bitrate || 0})));
        play();
      });
      player.on(HlsPlayer.Events.FRAG_LOADED, (_event,data) => {
        if (!active || data.frag.type !== 'main') return;
        const stats = data.part?.stats || data.frag.stats, elapsed = stats.loading.end - stats.loading.start;
        if (Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(stats.loaded) && stats.loaded > 0) setSpeed(Math.round(stats.loaded / elapsed));
      });
      player.attachMedia(element); player.loadSource(source);
    })().catch(fail);
    return () => {
      active = false; window.clearTimeout(timeout);
      element.removeEventListener('playing', playing); element.removeEventListener('error', fail);
      element.removeEventListener('waiting',waiting); element.removeEventListener('stalled',waiting);
      element.removeEventListener('pause',paused); element.removeEventListener('ended',paused);
      element.removeEventListener('loadedmetadata',dimensions); element.removeEventListener('resize',dimensions);
      presentationEvents.forEach(event => element.removeEventListener(event, presentationChanged));
      void closeFloatingVideo(element).catch(() => {});
      if (hls.current === player) hls.current = null;
      player?.destroy(); element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [source,viewingBlocked]);
  async function togglePictureInPicture() {
    const element = video.current;
    if (!element || !pipMode || viewingBlocked) return;
    setPipError(false);
    try {
      if (isFloating(element)) await closeFloatingVideo(element);
      else if (pipMode === 'standard') await element.requestPictureInPicture();
      else element.webkitSetPresentationMode?.('picture-in-picture');
      // The browser may finish opening its window after the player has been removed.
      if (video.current !== element) await closeFloatingVideo(element);
    } catch {
      if (video.current === element) setPipError(true);
    }
  }
  async function start() {
    if (viewingBlocked || pending.current || source) return;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(false); setMessage(t(MSG.CONNECTING_VIDEO)); resetMetrics();
    try {
      const result = await api.cameraStream(deviceId, provider, controller.signal);
      if (controller.signal.aborted) return;
      const url = new URL(result.url);
      if (result.device_id !== deviceId || result.type !== 'hls' || url.protocol !== 'https:' || url.username || url.password) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_INVALID_VIDEO_STREAM));
      setSource(result.url);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(true); setMessage(failure instanceof ApiError ? failure.message : t(MSG.COULD_NOT_CONNECT_TO_THE_CAMERA_VIDEO));
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }
  useEffect(()=>{ if (viewingBlocked) stop(); },[viewingBlocked]);
  // Dashboard previews mount after the user opens live view.
  useEffect(() => { if (autoStart) void start(); }, [autoStart]);
  return <section className={"camera-live" + (compact ? " camera-live-compact" : "") + (sheet ? " camera-live-sheet" : "")} aria-label={t(MSG.CAMERA_VIDEO)}>
    <div className="camera-live-heading">{!sheet && <h3>{t(MSG.CAMERA_VIDEO)}</h3>}
      <div className="camera-live-actions">{headingActions}
        {source && !viewingBlocked && !overlay && pipMode && <button type="button" className="secondary compact" aria-pressed={pipActive} onClick={() => void togglePictureInPicture()}>{t(MSG.PICTURE_IN_PICTURE)}</button>}
        {source || loading ? <button className="secondary compact" onClick={stop}>{t(MSG.STOP)}</button> : <button className="compact" disabled={!!viewingBlocked} title={viewingBlocked} onClick={() => void start()}>{error ? t(MSG.RECONNECT) : t(MSG.WATCH_VIDEO)}</button>}
      </div>
    </div>
    {!compact && <div className="camera-stream-info" aria-label={t(MSG.VIDEO_AND_CONNECTION_QUALITY)}>
      <label>HD/SD <select aria-label={t(MSG.HD_SD_VIDEO_QUALITY)} value={selectedLevel} disabled={!source || levels.length < 2} onChange={event => {
        const index = Number(event.target.value);
        if (!hls.current || (index !== -1 && !levels.some(level => level.index === index))) return;
        hls.current.currentLevel = index; setSelectedLevel(index);
      }}><option value={-1}>{levels.length < 2 && resolution ? resolution.split(' · ')[0] : t(MSG.AUTO)}</option>{levels.length > 1 && levels.map(level => <option key={level.index} value={level.index}>{level.width && level.height ? resolutionLabel(level.width,level.height) : t(MSG.VARIANT)+(level.index+1)}{level.bitrate > 0 ? ' · '+Math.round(level.bitrate/1000)+t(MSG.KBIT_S) : ''}</option>)}</select></label>
      <span>{resolution || t(MSG.RESOLUTION)}</span>
      <span>{t(MSG.VIDEO_CONNECTION) + " "}{error ? t(MSG.ERROR) : loading ? t(MSG.CONNECTION) : !source ? t(MSG.PLAYBACK_OFF) : playback}</span>
      <span title={t(MSG.DOWNLOAD_SPEED_OF_THE_MOST_RECENT_VIDEO_SEGMENT)}>{t(MSG.DOWNLOAD) + " "}{speed === null ? '—' : speed+t(MSG.KB_S)}</span>
      <span title={networkSignal ? t(MSG.LAST_SIGNAL_READING_REPORTED_BY_THE_CAMERA) : t(MSG.THE_CONNECTION_DID_NOT_PROVIDE_A_CAMERA_SIGNAL)}>Wi-Fi: {networkSignal || t(MSG.NO_DATA)}</span>
      <p className="help">{!source ? t(MSG.AVAILABLE_HD_SD_VARIANTS_WILL_APPEAR_AFTER_VIDEO) : levels.length < 2 ? t(MSG.HD_SD_SWITCHING_IS_UNAVAILABLE_FOR_THIS_STREAM) : t(MSG.QUALITY_IS_SELECTED_FROM_THE_VIDEO_STREAMS_AVAILABLE)}</p>
    </div>}
    {compact && !source && !overlay && <div className="camera-preview-placeholder" aria-hidden="true"><IconGlyph name={sheet && viewingBlocked ? 'video-blocked' : 'play'} /></div>}
    {(!viewingBlocked && source || overlay) && <div className={"camera-frame"+(overlay ? " camera-frame-with-overlay" : "")} style={overlay ? {aspectRatio:aspect} : undefined}>
      {source && !viewingBlocked ? <video ref={video} controls={!overlay} disablePictureInPicture={!!overlay} muted autoPlay playsInline preload="none" aria-label={t(MSG.LIVE_CAMERA_VIDEO)} /> : <div className="camera-area-placeholder">{viewingBlocked || t(MSG.PRESS_WATCH_VIDEO_TO_SEE_THE_IMAGE)}</div>}{overlay}
      {sheet && source && !viewingBlocked && <>
        {playback === t(MSG.PLAYING) && <span className="camera-sheet-live-tag">{t(MSG.LIVE)}</span>}
        {(document.fullscreenEnabled || 'webkitEnterFullscreen' in HTMLVideoElement.prototype) && <button type="button" className="camera-sheet-fullscreen" aria-label={t(MSG.FULL_SCREEN)} onClick={() => {
          const player = video.current;
          if (player?.requestFullscreen && document.fullscreenEnabled) void player.requestFullscreen().catch(() => {});
          else player?.webkitEnterFullscreen?.();
        }}><IconGlyph name="fullscreen" /></button>}
      </>}
    </div>}
    <p className={error ? 'error' : 'help'} role={error ? 'alert' : 'status'}>{viewingBlocked || message}</p>
    {source && !viewingBlocked && pipError && <p className="error" role="alert">{t(MSG.COULD_NOT_SWITCH_PICTURE_IN_PICTURE_MODE)}</p>}
  </section>;
}
