import { useEffect, useRef, useState } from 'react';
import { ApiError, CloudApi } from '../api';
import type { Provider } from '../api';
import type Hls from 'hls.js';
import type { ReactNode } from 'react';

type VideoLevel = {index:number; width:number; height:number; bitrate:number};
function resolutionLabel(width:number, height:number) {
  return (Math.min(width,height) >= 720 ? 'HD' : 'SD') + ' · ' + width + '×' + height;
}

export function CameraLive({ api, deviceId, provider, onAuthError, compact = false, autoStart = false, networkSignal, headingActions, overlay }: {
  api: CloudApi; deviceId: string; provider: Provider; onAuthError: () => void; compact?: boolean; autoStart?: boolean; networkSignal?: string; headingActions?:ReactNode; overlay?:ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null), pending = useRef<AbortController | null>(null);
  const hls = useRef<Hls | null>(null);
  const [source, setSource] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Видео включается только по вашему запросу.');
  const [error, setError] = useState(false);
  const [levels,setLevels] = useState<VideoLevel[]>([]), [selectedLevel,setSelectedLevel] = useState(-1);
  const [resolution,setResolution] = useState(''), [speed,setSpeed] = useState<number | null>(null);
  const [playback,setPlayback] = useState('Подключение');
  const [aspect,setAspect] = useState(16/9);
  function resetMetrics() { setLevels([]); setSelectedLevel(-1); setResolution(''); setSpeed(null); setPlayback('Подключение'); }
  function stop() {
    pending.current?.abort(); pending.current = null;
    setLoading(false); setSource(null); setError(false); setMessage('Просмотр остановлен.'); resetMetrics();
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
      setError(true); setMessage('Не удалось воспроизвести видео. Попробуйте подключиться заново.'); setSource(null); resetMetrics();
    };
    const timeout = window.setTimeout(fail, 45_000);
    const dimensions = () => { if (element.videoWidth > 0 && element.videoHeight > 0) {setResolution(resolutionLabel(element.videoWidth,element.videoHeight)); setAspect(element.videoWidth/element.videoHeight);} };
    const playing = () => { window.clearTimeout(timeout); setMessage('Прямой эфир'); setPlayback('Воспроизводится'); dimensions(); };
    const waiting = () => setPlayback('Буферизация'), paused = () => setPlayback('Пауза');
    element.addEventListener('playing', playing);
    element.addEventListener('error', fail);
    element.addEventListener('waiting',waiting); element.addEventListener('stalled',waiting);
    element.addEventListener('pause',paused); element.addEventListener('ended',paused);
    element.addEventListener('loadedmetadata',dimensions); element.addEventListener('resize',dimensions);
    const play = () => { void element.play().catch(() => { if (active) setMessage('Нажмите ▶ в плеере для просмотра.'); }); };
    void (async () => {
      const { default: HlsPlayer } = await import('hls.js');
      if (!active) return;
      if (!HlsPlayer.isSupported()) {
        if (element.canPlayType('application/vnd.apple.mpegurl')) { element.src = source; play(); return; }
        setError(true); setMessage('Этот браузер не поддерживает просмотр HLS-видео.'); setSource(null); return;
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
      if (hls.current === player) hls.current = null;
      player?.destroy(); element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [source]);
  async function start() {
    if (pending.current || source) return;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(false); setMessage('Подключаем видео…'); resetMetrics();
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
      <div className="camera-live-actions">{headingActions}{source || loading ? <button className="secondary compact" onClick={stop}>Остановить</button> : <button className="compact" onClick={() => void start()}>{error ? 'Подключиться заново' : 'Смотреть видео'}</button>}</div>
    </div>
    {!compact && <div className="camera-stream-info" aria-label="Качество видео и связи">
      <label>HD/SD <select aria-label="Качество видео HD/SD" value={selectedLevel} disabled={!source || levels.length < 2} onChange={event => {
        const index = Number(event.target.value);
        if (!hls.current || (index !== -1 && !levels.some(level => level.index === index))) return;
        hls.current.currentLevel = index; setSelectedLevel(index);
      }}><option value={-1}>{levels.length < 2 && resolution ? resolution.split(' · ')[0] : 'Авто'}</option>{levels.length > 1 && levels.map(level => <option key={level.index} value={level.index}>{level.width && level.height ? resolutionLabel(level.width,level.height) : 'Вариант '+(level.index+1)}{level.bitrate > 0 ? ' · '+Math.round(level.bitrate/1000)+' кбит/с' : ''}</option>)}</select></label>
      <span>{resolution || 'Разрешение —'}</span>
      <span>Видеосвязь: {error ? 'Ошибка' : loading ? 'Подключение' : !source ? 'Просмотр выключен' : playback}</span>
      <span title="Скорость загрузки последнего видеосегмента в браузере.">Загрузка: {speed === null ? '—' : speed+' КБ/с'}</span>
      <span title={networkSignal ? 'Последнее показание сигнала, сообщённое камерой.' : 'Подключение не предоставило уровень сигнала камеры.'}>Wi-Fi: {networkSignal || 'Нет данных'}</span>
      <p className="help">{!source ? 'Доступные варианты HD/SD появятся после запуска видео.' : levels.length < 2 ? 'Переключение HD/SD недоступно для этого потока.' : 'Качество выбирается из вариантов видеопотока.'}</p>
    </div>}
    {compact && !source && !overlay && <div className="camera-preview-placeholder" aria-hidden="true">▷</div>}
    {(source || overlay) && <div className={"camera-frame"+(overlay ? " camera-frame-with-overlay" : "")} style={overlay ? {aspectRatio:aspect} : undefined}>
      {source ? <video ref={video} controls={!overlay} muted autoPlay playsInline preload="none" aria-label="Прямой эфир камеры" /> : <div className="camera-area-placeholder">Для изображения нажмите «Смотреть видео»</div>}{overlay}
    </div>}
    <p className={error ? 'error' : 'help'} role={error ? 'alert' : 'status'}>{message}</p>
  </section>;
}
