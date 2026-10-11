import { useEffect, useRef, useState } from 'react';
import { ApiError, CloudApi } from '../api';
import type { Provider } from '../api';
import type Hls from 'hls.js';

export function CameraLive({ api, deviceId, provider, onAuthError, compact = false, autoStart = false }: {
  api: CloudApi; deviceId: string; provider: Provider; onAuthError: () => void; compact?: boolean; autoStart?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null), pending = useRef<AbortController | null>(null);
  const [source, setSource] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Видео включается только по вашему запросу.');
  const [error, setError] = useState(false);
  function stop() {
    pending.current?.abort(); pending.current = null;
    setLoading(false); setSource(null); setError(false); setMessage('Просмотр остановлен.');
  }
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { pending.current?.abort(); pending.current = null; document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    let active = true, player: Hls | undefined;
    const fail = () => {
      if (!active) return;
      setError(true); setMessage('Не удалось воспроизвести видео. Попробуйте подключиться заново.'); setSource(null);
    };
    const timeout = window.setTimeout(fail, 45_000);
    const playing = () => { window.clearTimeout(timeout); setMessage('Прямой эфир'); };
    element.addEventListener('playing', playing);
    element.addEventListener('error', fail);
    const play = () => { void element.play().catch(() => { if (active) setMessage('Нажмите ▶ в плеере для просмотра.'); }); };
    void (async () => {
      const { default: HlsPlayer } = await import('hls.js');
      if (!active) return;
      if (!HlsPlayer.isSupported()) {
        if (element.canPlayType('application/vnd.apple.mpegurl')) { element.src = source; play(); return; }
        setError(true); setMessage('Этот браузер не поддерживает просмотр HLS-видео.'); setSource(null); return;
      }
      player = new HlsPlayer({ debug:false, enableWorker:true, lowLatencyMode:true, backBufferLength:15, maxBufferLength:20 });
      player.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) fail(); });
      player.on(HlsPlayer.Events.MANIFEST_PARSED, play);
      player.attachMedia(element); player.loadSource(source);
    })().catch(fail);
    return () => {
      active = false; window.clearTimeout(timeout);
      element.removeEventListener('playing', playing); element.removeEventListener('error', fail);
      player?.destroy(); element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [source]);
  async function start() {
    if (pending.current || source) return;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(false); setMessage('Подключаем видео…');
    try {
      const result = await api.cameraStream(deviceId, provider, controller.signal);
      if (controller.signal.aborted) return;
      const url = new URL(result.url);
      if (result.device_id !== deviceId || result.type !== 'hls' || url.protocol !== 'https:' || url.username || url.password) throw new Error('Сервис вернул недопустимый видеопоток.');
      setSource(result.url);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(true); setMessage(failure instanceof ApiError ? failure.message : 'Не удалось подключить видео камеры.');
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }
  // Inline instances mount only after the user expands the camera tile.
  useEffect(() => { if (autoStart) void start(); }, [autoStart]);
  return <section className={"camera-live" + (compact ? " camera-live-compact" : "")} aria-label="Видео камеры">
    <div className="camera-live-heading"><h3>Видео камеры</h3>
      {source || loading ? <button className="secondary compact" onClick={stop}>Остановить</button> : <button className="compact" onClick={() => void start()}>{error ? 'Подключиться заново' : 'Смотреть видео'}</button>}
    </div>
    {compact && !source && <div className="camera-preview-placeholder" aria-hidden="true">▷</div>}
    {source && <video ref={video} controls muted autoPlay playsInline preload="none" aria-label="Прямой эфир камеры" />}
    <p className={error ? 'error' : 'help'} role={error ? 'alert' : 'status'}>{message}</p>
  </section>;
}
