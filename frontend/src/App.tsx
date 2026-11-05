import { t, useLocale } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, CloudApi, normalizeApiBase } from './api';
import type { CloudStatus, Connection, DeveloperCredentials, Provider } from './api';
import { loadConnection, saveConnection } from './connection';
import { ConnectionSettings } from './components/ConnectionSettings';
import { LanguageSelector } from './components/LanguageSelector';
import { ThemeSelector } from './components/ThemeSelector';
import { DeveloperForm, REGIONS, UserCodeForm } from './components/CredentialForms';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';
import { NetworkPage } from './components/NetworkPage';
import { LocalConnectionsPage } from './components/LocalConnectionsPage';
import { deviceHref, readDeviceLink } from './device-links';
import type { DeviceLink } from './device-links';

type Notice = { text: string; error?: boolean };
type QR = { session: string; imageUrl: string; expiresAt: number };
type View = 'connections' | 'control' | 'network' | 'local-connections';

export function App() {
  const locale = useLocale();
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const [connection, setConnection] = useState<Connection>(() => loadConnection());
  const [view, setView] = useState<View>(() => connection.token ? window.location.hash === '#local-connections' ? 'local-connections' : window.location.hash === '#network' ? 'network' : 'control' : 'connections');
  const [deviceTarget, setDeviceTarget] = useState(() => readDeviceLink(window.location.hash));
  const acceptedHash = useRef(window.location.hash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dashboardPanel, setDashboardPanel] = useState<'search' | 'tools' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const [controlOpen, setControlOpen] = useState(false);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [provider, setProvider] = useState<Provider>('sharing');
  const [notice, setNotice] = useState<Notice>({ text: '' });
  const [busy, setBusy] = useState(Boolean(connection.token));
  const busyRef = useRef(busy);
  const verified = useRef<Connection | null>(null);
  const [editingCode, setEditingCode] = useState(false);
  const [editingDeveloper, setEditingDeveloper] = useState(false);
  const [qr, setQR] = useState<QR | null>(null);
  const [remaining, setRemaining] = useState(0);
  const api = useMemo(() => new HomeApi(connection), [connection]);
  const locked = busy || controlOpen;
  const developer = status?.developer || { configured: false, connected: false };
  const ready = Boolean(status?.enabled && connection.token);
  const showCodeForm = ready && (!status?.has_saved_user_code || editingCode);
  const showDeveloperForm = ready && (!developer.configured || editingDeveloper);
  const accountConnected = provider === 'sharing' ? Boolean(status?.connected) : developer.connected;

  function invalidateConnection() {
    const next = { ...connection, token: '' };
    try { saveConnection(next); } catch { /* Still invalidate the in-memory token. */ }
    verified.current = next;
    setConnection(next); setStatus(null); setQR(null);
    setControlOpen(false); setView('connections');
  }

  useEffect(() => {
    if (!connection.token || verified.current === connection) return;
    const controller = new AbortController();
    let active = true;
    busyRef.current = true; setBusy(true);
    void api.status(controller.signal).then(value => {
      if (active) {
        setStatus(value); verified.current = connection; setNotice({ text: '' });
        busyRef.current = false; setBusy(false);
      }
    }).catch(error => {
      if (!active) return;
      busyRef.current = false; setBusy(false);
      setNotice({ text: error instanceof Error ? error.message : t("Не удалось подключиться."), error: true });
      if (error instanceof ApiError && error.status === 401) invalidateConnection();
    });
    return () => { active = false; controller.abort(); };
  }, [api, connection]);

  useEffect(() => {
    if (!qr) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((qr.expiresAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) { setQR(null); setNotice({ text: t("Срок QR-кода истёк. Получите новый код.") }); }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => { clearInterval(timer); URL.revokeObjectURL(qr.imageUrl); };
  }, [qr]);

  async function run(work: () => Promise<void>, invalidateOn401 = false) {
    if (busyRef.current || controlOpen) return;
    busyRef.current = true; setBusy(true); setNotice({ text: '' });
    try { await work(); }
    catch (error) {
      if (invalidateOn401 && error instanceof ApiError && error.status === 401) invalidateConnection();
      setNotice({ text: error instanceof Error ? error.message : t("Не удалось выполнить действие."), error: true });
    } finally { busyRef.current = false; setBusy(false); }
  }

  const saveAccess = (address: string, candidate: string) => run(async () => {
    const baseUrl = normalizeApiBase(address);
    // Changing the API host requires a newly entered key. A saved key is reused
    // only for its original API, never sent to another host by an address edit.
    const token = candidate.trim() || (baseUrl === connection.baseUrl ? connection.token : '');
    if (!token) throw new Error(t("Введите ключ доступа для этого API."));
    const next = { baseUrl, token };
    const nextStatus = await new CloudApi(next).status();
    saveConnection(next);
    verified.current = next;
    setConnection(next); setStatus(nextStatus); setQR(null);
    setEditingCode(false); setEditingDeveloper(false);
    setNotice({ text: t("Подключение сохранено.") });
  });

  const saveCode = (code: string) => run(async () => {
    if (!code.trim()) throw new Error(t("Введите User Code."));
    const saved = await api.saveCode(code.trim());
    setStatus(current => current ? { ...current, ...saved } : null);
    setEditingCode(false); setQR(null);
    setNotice({ text: saved.saved_user_code_requires_login ? t("User Code сохранён. Подтвердите QR-вход.") : t("User Code сохранён на сервере.") });
  }, true);

  const saveDeveloper = (credentials: DeveloperCredentials) => run(async () => {
    if (!credentials.access_id || !credentials.access_secret) throw new Error(t("Введите Access ID и Access Secret."));
    const saved = await api.saveDeveloper(credentials);
    setStatus(current => current ? { ...current, developer: saved } : null);
    setEditingDeveloper(false);
    setNotice({ text: t("Реквизиты сохранены на сервере. Теперь проверьте подключение.") });
  }, true);

  const connectDeveloper = () => run(async () => {
    const saved = await api.connectDeveloper();
    setStatus(current => current ? { ...current, developer: saved } : null);
    setNotice({ text: t("Tuya Developer подключён. Найдено устройств: {0}.", [saved.device_count ?? 0]) });
  }, true);

  const beginQR = () => run(async () => {
    setQR(null);
    const login = await api.beginQR();
    const image = await api.qrImage(login);
    const seconds = Number.isFinite(login.expires_in) ? Math.min(120, Math.max(1, login.expires_in)) : 120;
    setQR({ session: login.session_id, imageUrl: URL.createObjectURL(image), expiresAt: Date.now() + seconds * 1000 });
    setNotice({ text: t("Сканируйте код в Smart Life / Tuya Smart и подтвердите вход в приложении.") });
  }, true);

  const confirmQR = () => run(async () => {
    if (!qr) return;
    await api.confirmQR(qr.session);
    setQR(null); setStatus(await api.status());
    setNotice({ text: t("Аккаунт подключён. User Code и токены сохранены на сервере.") });
  }, true);

  function chooseProvider(value: Provider) {
    if (busyRef.current) return;
    setProvider(value); setQR(null); setNotice({ text: '' });
  }

  function navigate(next: View) {
    setView(next); setDeviceTarget(null); setMenuOpen(false); setNotice({ text: '' }); setQR(null);
    acceptedHash.current = next === 'network' || next === 'local-connections' ? '#' + next : '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search + acceptedHash.current);
  }
  const changeDeviceTarget = useCallback((target: DeviceLink | null) => {
    const hash = target ? deviceHref(target.id, target.route) : '';
    setDeviceTarget(target); acceptedHash.current = hash;
    if (window.location.hash !== hash) window.history[target ? 'pushState' : 'replaceState'](null, '', window.location.pathname + window.location.search + hash);
  }, []);
  useEffect(() => {
    const changed = () => {
      const dialogs = document.querySelectorAll('dialog[open]');
      if (busyRef.current || document.querySelector('dialog[open][aria-busy="true"]') || dialogs.length > 1 || (controlOpen && !dialogs.length)) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + acceptedHash.current);
        return;
      }
      acceptedHash.current = window.location.hash;
      setDeviceTarget(readDeviceLink(window.location.hash)); setMenuOpen(false); setNotice({ text: '' });
      setView(window.location.hash === '#network' ? 'network' : window.location.hash === '#local-connections' ? 'local-connections' : 'control');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [controlOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);

  const regionName = REGIONS.find(item => item.value === developer.region)?.label;
  return <div className={"app-shell" + (view === 'control' ? " dashboard-view" : "")} data-dashboard-panel={dashboardPanel ?? undefined}>
    <header className="app-header"><div className="app-menu" ref={menuRef} onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } }}>
      <button className="secondary app-menu-button" ref={menuButton} aria-label={t("Меню")} aria-expanded={menuOpen} aria-controls="app-sections" disabled={locked} onClick={() => setMenuOpen(value => !value)}><span aria-hidden="true">☰</span></button>
      {menuOpen && <nav id="app-sections" className="app-menu-panel" aria-label={t("Раздел приложения")}>{([['control', t("Управление")], ['network', t("Сеть и пакеты")], ['local-connections', t("Локальные подключения")], ['connections', t("Подключения")]] as const).map(([key, label]) => <button key={key} className="secondary" aria-current={view === key ? 'page' : undefined} disabled={locked} onClick={() => navigate(key)}>{label}</button>)}
        {view === 'control' && status && <button className="secondary dashboard-tools-menu" disabled={locked} aria-expanded={dashboardPanel === 'tools'} onClick={() => {
          setDashboardPanel(panel => panel === 'tools' ? null : 'tools');
          setMenuOpen(false);
          menuButton.current?.focus();
        }}>{t("Настройки панели")}</button>}
      </nav>}
    </div><div className="brand"><span className="brand-icon" aria-hidden="true">⌂</span><div><strong>Smart Home</strong><span className="brand-tagline">{t("Ваш дом под управлением")}</span>
      {view === 'control' && <span className={"dashboard-connection" + (status ? " online" : "")}><i aria-hidden="true" />{status ? t("Подключено") : t("API не подключён")}</span>}
    </div></div>
      <div className="appearance-settings"><ThemeSelector /><LanguageSelector /></div><span className={'api-presence ' + (status ? 'online' : '')}><i aria-hidden="true" />{status ? t("API подключён") : t("API не подключён")}</span>
      {view === 'control' && status && <button className="secondary dashboard-search-button" type="button" aria-label={t("Поиск")} aria-expanded={dashboardPanel === 'search'} aria-controls="dashboard-search" disabled={locked} onClick={() => {
        setMenuOpen(false);
        setDashboardPanel(panel => panel === 'search' ? null : 'search');
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
      </button>}
    </header>
    <main>
      <input id="access-token" type="hidden" value={connection.token} readOnly />
      {view === 'connections' ? <>
      <div className="page-heading"><p className="eyebrow">{t("Подключения")}</p><h1>{ready && accountConnected ? t("Tuya подключена") : t("Подключить Tuya")}</h1><p className="muted">{ready && accountConnected ? t("Сохранённое подключение готово к управлению устройствами через интернет.") : t("Свяжите аккаунт и получите доступ к устройствам. Облачное подключение требует интернета.")}</p></div>
      <div className="workspace connections-workspace">
        <section className="card setup" aria-label={t("Подключение Tuya")}>
          <div className="method-tabs" role="group" aria-label={t("Способ подключения")}>
            <button aria-pressed={provider === 'sharing'} disabled={locked} onClick={() => chooseProvider('sharing')}>Smart Life / QR</button>
            <button aria-pressed={provider === 'developer'} disabled={locked} onClick={() => chooseProvider('developer')}>Access ID / Secret</button>
          </div>
          {provider === 'sharing' ? <div className="provider-panel">
            <p className="eyebrow">{t("Вход через приложение")}</p><h2>Smart Life / Tuya Smart</h2>
            <p className="muted">{ready && status?.connected ? t("Tuya-аккаунт подключён. Авторизация сохранена на сервере; повторный QR-вход нужен для смены аккаунта или восстановления доступа.") : t("Сохраните User Code, затем подтвердите вход с помощью QR-кода.")}</p>
            {!ready ? <p className="saved-summary">{status && !status.enabled ? t("Облачный режим выключен на сервере.") : t("Сначала сохраните доступ к API в настройках подключения.")}</p> : <>
              {showCodeForm ? <UserCodeForm busy={busy} canCancel={Boolean(status?.has_saved_user_code)} onSave={saveCode} onCancel={() => setEditingCode(false)} /> : <p className="saved-summary">{t("User Code сохранён на сервере.") + " "}<a href="#user-code" aria-controls="user-code" aria-expanded={false} aria-disabled={busy} onClick={event => {
                event.preventDefault(); if (!busyRef.current) { setEditingCode(true); setQR(null); setNotice({ text: '' }); }
              }}>{t("Хочу изменить")}</a></p>}
              {status?.saved_user_code_requires_login && !showCodeForm && <p className="help">{t("Для этого User Code нужно подтвердить QR-вход.")}</p>}
            </>}
            <button className="full-width" disabled={busy || !ready || !status?.has_saved_user_code || showCodeForm} onClick={beginQR}>{t("Получить QR-код")}</button>
            {qr && <div className="qr-panel"><img src={qr.imageUrl} alt={t("QR-код для входа в Tuya")} /><p className="help">{t("Сканируйте код в приложении. Осталось") + " "}{remaining}{" " + t("сек.")}</p><button className="full-width" disabled={busy || !ready || remaining === 0} onClick={confirmQR}>{t("Я подтвердил вход в приложении")}</button></div>}
          </div> : <div className="provider-panel">
            <p className="eyebrow">{t("Вход через облачный проект")}</p><h2>Tuya Developer</h2>
            <p className="muted">{t("Аккаунт Smart Life должен быть привязан к проекту Tuya. Выберите дата-центр проекта.")}</p>
            {!ready ? <p className="saved-summary">{status && !status.enabled ? t("Облачный режим выключен на сервере.") : t("Сначала сохраните доступ к API в настройках подключения.")}</p> : <>
              {showDeveloperForm ? <DeveloperForm region={developer.region} busy={busy} canCancel={developer.configured} onSave={saveDeveloper} onCancel={() => setEditingDeveloper(false)} /> : <p className="saved-summary">{developer.connected ? t("Подключение проверено.") : t("Реквизиты сохранены.")} {regionName}. <a href="#developer-form" aria-controls="developer-form" aria-expanded={false} aria-disabled={busy} onClick={event => {
                event.preventDefault(); if (!busyRef.current) { setEditingDeveloper(true); setNotice({ text: '' }); }
              }}>{t("Хочу изменить")}</a></p>}
            </>}
            <button className="full-width" disabled={busy || !ready || !developer.configured || showDeveloperForm} onClick={connectDeveloper}>{t("Проверить и подключить")}</button>
            <p className="help">{t("Доступ зависит от разрешений и плана API проекта Tuya.")}</p>
          </div>}
          <div className="privacy-note"><span aria-hidden="true">✓</span><p>{t("User Code, реквизиты Tuya, токены и локальные ключи остаются на Python-сервисе.")}</p></div>
        </section>
      </div>
      </> : view === 'network' ? <NetworkPage api={api} ready={Boolean(status && connection.token)} onAuthError={invalidateConnection} /> : view === 'local-connections' ? <LocalConnectionsPage api={api} ready={ready} sharingReady={Boolean(ready && status?.connected)} developerReady={Boolean(ready && developer.connected)} onAuthError={invalidateConnection} onLock={setControlOpen} onConnections={() => navigate('connections')} /> : <ControlCenter mobilePanel={dashboardPanel} api={api} ready={Boolean(status && connection.token)} sharingReady={Boolean(ready && status?.connected)} developerReady={Boolean(ready && developer.connected)} onAuthError={invalidateConnection} onLock={setControlOpen} onConnections={() => navigate('connections')} deviceLink={deviceTarget} onDeviceLinkChange={changeDeviceTarget} />}
      <div className={'notice ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'} aria-live="polite">{busy ? <><span className="spinner" aria-hidden="true" />{t("Подождите…")}</> : t(notice.text)}</div>
      {view === 'connections' && <ConnectionSettings connection={connection} busy={locked} onSave={saveAccess} />}
    </main>
    <footer><span>Smart Home · Tuya</span></footer>
  </div>;
}
