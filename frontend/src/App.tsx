import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import { Provider as StoreProvider } from 'react-redux';
import {
  createBrowserRouter, createHashRouter, Outlet, useBlocker, useLocation, useMatches, useNavigate, useOutletContext,
} from 'react-router';
import type { RouteObject } from 'react-router';
import {
  MSG, t, useLocale, translateText,
} from './i18n';
import { ApiError, CloudApi, normalizeApiBase } from './api';
import type {
  CloudStatus, Connection, DeveloperCredentials, Provider,
} from './api';
import {
  clearConnection, DEFAULT_API_BASE, loadConnection, saveConnection, STORAGE_KEY,
} from './connection';
import { ConnectionSettings } from './components/ConnectionSettings';
import HouseholdAccess from './components/HouseholdAccess';
import { readHouseholdSignIn } from './household-login';
import { LanguageSelector } from './components/LanguageSelector';
import DeviceTextModeSelector from './components/DeviceTextModeSelector';
import { ThemeSelector } from './components/ThemeSelector';
import { DeveloperForm, REGIONS, UserCodeForm } from './components/CredentialForms';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';
import { NetworkPage } from './components/NetworkPage';
import { LocalConnectionsPage } from './components/LocalConnectionsPage';
import RoomEditor from './components/RoomEditor';
import { Icon, IconGlyph } from './components/ui/icon';
import {
  appPaths, combinationEditPattern, combinationEditPreviewPattern, combinationNewPath, combinationNewPreviewPath, combinationPattern, combinationQuickPattern,
  dashboardHref, dashboardLayoutPath, dashboardRoom, dashboardToolsPath, devicePattern, groupPattern, legacyHref, quickPattern, roomLayoutPattern, roomPattern,
} from './navigation';
import type { DashboardPanel } from './navigation';
import { createAppStore, selectDashboardLocked, useAppSelector } from './store';
import { rotateCloudAccountScope } from './cloud-account-scope';

type Notice = { text: string; error?: boolean };
type QR = { session: string; imageUrl: string; expiresAt: number };
type View = keyof typeof appPaths;
type CardSize = 'large' | 'small';
type ViewContext = { pages: Record<View, ReactNode>; view: View };
const demo = import.meta.env.MODE === 'demo';
const CARD_SIZE_STORAGE_KEY = 'smart-home.ui.card-size.v1';

function savedCardSize(): CardSize {
  try { return localStorage.getItem(CARD_SIZE_STORAGE_KEY) === 'small' ? 'small' : 'large'; }
  catch { return 'large'; }
}

function App() {
  const [store, setStore] = useState(createAppStore);
  const resetSessionStore = useCallback(() => setStore(createAppStore()), []);
  return (
    <StoreProvider store={store}>
      <AppContent resetSessionStore={resetSessionStore} />
    </StoreProvider>
  );
}

function screenRoute(path: string, view: View, id = path): RouteObject {
  return {
    id, ...(path === '/' ? { index: true } : { path }), handle: view, element: <AppScreen />,
  };
}

function ownerPage(view: View) {
  return view === 'network' || view === 'local-connections' || view === 'rooms' || view === 'combined-devices';
}

function AppScreen() {
  const { pages, view } = useOutletContext<ViewContext>();
  return pages[view];
}

export function createAppRouter() {
  const createRouter = demo ? createHashRouter : createBrowserRouter;
  return createRouter([{ element: <App />, children: [
    screenRoute(appPaths.control, 'control'),
    screenRoute(roomPattern, 'control'),
    screenRoute(dashboardLayoutPath, 'control'),
    screenRoute(roomLayoutPattern, 'control'),
    screenRoute(devicePattern, 'control'),
    screenRoute(quickPattern, 'control'),
    screenRoute(groupPattern, 'control'),
    screenRoute(appPaths['combined-devices'], 'combined-devices'),
    screenRoute(combinationNewPath, 'combined-devices'),
    screenRoute(combinationNewPreviewPath, 'combined-devices'),
    screenRoute(combinationPattern, 'control'),
    screenRoute(combinationQuickPattern, 'control'),
    screenRoute(combinationEditPattern, 'combined-devices'),
    screenRoute(combinationEditPreviewPattern, 'combined-devices'),
    screenRoute(dashboardToolsPath, 'control'),
    screenRoute(appPaths.settings, 'settings'),
    ...(!demo ? [
      screenRoute(appPaths.rooms, 'rooms'),
      screenRoute(appPaths.users, 'users'),
      screenRoute(appPaths.connections, 'connections'),
      screenRoute(appPaths.network, 'network'),
      screenRoute(appPaths['local-connections'], 'local-connections'),
    ] : []),
    screenRoute('*', 'control'),
  ] }]);
}

function AppContent({ resetSessionStore }: { resetSessionStore: () => void }) {
  const locale = useLocale();
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const [connection, setConnection] = useState<Connection>(() => (demo ? { baseUrl: 'https://smart-home-demo.invalid', token: 'demo' } : loadConnection()));
  const location = useLocation();
  const navigate = useNavigate();
  const matched = useMatches().at(-1)!;
  const [invitation, setInvitation] = useState(() => (
    !demo && location.pathname === appPaths.connections ? readHouseholdSignIn(location.hash) : undefined
  ));
  const query = new URLSearchParams(location.search);
  const requestedView = matched.handle as View;
  const needsAccess = !connection.token && requestedView !== 'settings' && requestedView !== 'connections';
  const panelParam = query.get('panel');
  const dashboardPanel: DashboardPanel = matched.id === dashboardToolsPath || panelParam === 'tools' ? 'tools' : panelParam === 'search' ? 'search' : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [cardSize, setCardSize] = useState(savedCardSize);
  const menuRef = useRef<HTMLDivElement>(null); const
    menuButton = useRef<HTMLButtonElement>(null);
  const [localConnectionLocked, setLocalConnectionLocked] = useState(false);
  const dashboardLocked = useAppSelector(selectDashboardLocked);
  const controlLocked = dashboardLocked || localConnectionLocked;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  const currentConnection = useRef(connection);
  const member = status?.account?.role === 'member';
  const identity = status?.account;
  const showIntegration = Boolean(status && !member);
  let view = requestedView;
  if (needsAccess) view = 'connections';
  else if (member && ownerPage(requestedView)) view = 'control';
  const provider: Provider = query.get('provider') === 'developer' ? 'developer' : 'sharing';
  const [notice, setNotice] = useState<Notice>({ text: '' });
  const [busy, setBusy] = useState(Boolean(connection.token));
  const busyRef = useRef(busy);
  const verified = useRef<Connection | null>(null);
  const [editingCode, setEditingCode] = useState(false);
  const [editingDeveloper, setEditingDeveloper] = useState(false);
  const [qr, setQR] = useState<QR | null>(null);
  const [remaining, setRemaining] = useState(0);
  const api = useMemo(() => new HomeApi(connection, status?.account), [connection, status?.account]);
  const verificationApi = useMemo(() => new CloudApi(connection), [connection]);
  const locked = busy || controlLocked;
  const developer = status?.developer || { configured: false, connected: false };
  const ready = Boolean(status?.enabled && connection.token);
  const showCodeForm = ready && (!status?.has_saved_user_code || editingCode);
  const showDeveloperForm = ready && (!developer.configured || editingDeveloper);
  const accountConnected = provider === 'sharing' ? Boolean(status?.connected) : developer.connected;

  const blocker = useBlocker(({ historyAction }) => {
    if (historyAction !== 'POP') return false;
    const dialogs = document.querySelectorAll('dialog[open]');
    return busyRef.current || !!document.querySelector('dialog[open][aria-busy="true"]') || dialogs.length > 1 || (controlLocked && !dialogs.length);
  });
  useEffect(() => { if (blocker.state === 'blocked') blocker.reset(); }, [blocker]);

  useEffect(() => {
    const legacy = location.pathname === '/' ? legacyHref(location.hash) : null;
    const sharedSignIn = location.pathname === appPaths.connections ? readHouseholdSignIn(location.hash) : undefined;
    if (sharedSignIn) {
      setInvitation(sharedSignIn);
      navigate(location.pathname + location.search, { replace: true, state: location.state });
    } else if (identity?.needs_name && requestedView !== 'users') {
      navigate(appPaths.users, { replace: true });
    } else if (needsAccess) {
      const returnTo = legacy ?? (matched.id === '*' ? '/' : location.pathname + location.search);
      void navigate(appPaths.connections, { replace: true, state: returnTo === '/' ? null : { returnTo } });
    } else if (member && ownerPage(requestedView)) {
      navigate(appPaths.control, { replace: true });
    } else if (legacy || matched.id === '*') {
      void navigate(legacy ?? appPaths.control, { replace: true });
    }
  }, [identity?.needs_name, location, matched.id, member, needsAccess, navigate, requestedView]);

  const installSession = useCallback((next: Connection, nextStatus: CloudStatus | null) => {
    currentConnection.current = next;
    verified.current = next;
    setConnection(next);
    setStatus(nextStatus);
    setQR(null);
    setEditingCode(false);
    setEditingDeveloper(false);
    setLocalConnectionLocked(false);
    setSessionRevision((revision) => revision + 1);
    busyRef.current = false;
    setBusy(false);
    resetSessionStore();
  }, [resetSessionStore]);

  const invalidateConnection = useCallback(() => {
    if (currentConnection.current !== connection) return;
    const next = { ...connection, token: '' };
    try { clearConnection(next.baseUrl); } catch { /* Still invalidate the in-memory token. */ }
    installSession(next, null);
  }, [connection, installSession]);

  useEffect(() => {
    if (demo) return undefined;
    function onStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const { current } = currentConnection;
      const saved = loadConnection();
      if (current.token && (current.baseUrl !== saved.baseUrl || current.token !== saved.token)) {
        installSession({ ...current, token: '' }, null);
        setNotice({ text: '' });
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [installSession]);

  useEffect(() => {
    if (!connection.token || verified.current === connection) return;
    const controller = new AbortController();
    let active = true;
    busyRef.current = true; setBusy(true);
    void verificationApi.status(controller.signal).then((value) => {
      if (active && currentConnection.current === connection) {
        setStatus(value); verified.current = connection; setNotice({ text: '' });
        busyRef.current = false; setBusy(false);
      }
    }).catch((error) => {
      if (!active || currentConnection.current !== connection) return;
      busyRef.current = false; setBusy(false);
      setNotice({ text: error instanceof Error ? error.message : t(MSG.COULD_NOT_CONNECT), error: true });
      if (error instanceof ApiError && error.status === 401) invalidateConnection();
    });
    return () => { active = false; controller.abort(); };
  }, [verificationApi, connection, invalidateConnection]);

  useEffect(() => {
    if (!qr) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((qr.expiresAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) { setQR(null); setNotice({ text: t(MSG.THE_QR_CODE_HAS_EXPIRED) }); }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => { clearInterval(timer); URL.revokeObjectURL(qr.imageUrl); };
  }, [qr]);

  async function run(work: () => Promise<void>, invalidateOn401 = false) {
    if (busyRef.current || controlLocked) return;
    busyRef.current = true; setBusy(true); setNotice({ text: '' });
    try { await work(); } catch (error) {
      if (currentConnection.current !== connection) return;
      if (invalidateOn401 && error instanceof ApiError && error.status === 401) invalidateConnection();
      setNotice({ text: error instanceof Error ? error.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION), error: true });
    } finally {
      if (currentConnection.current === connection) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const saveAccess = (address: string, candidate: string, login: string) => run(async () => {
    const baseUrl = normalizeApiBase(invitation ? DEFAULT_API_BASE : address);
    // Changing the API host requires a newly entered key. A saved key is reused
    // only for its original API, never sent to another host by an address edit.
    const token = candidate.trim() || (baseUrl === connection.baseUrl ? connection.token : '');
    if (!token) throw new Error(t(MSG.ENTER_THE_ACCESS_KEY_FOR_THIS_API));
    const next = { baseUrl, token };
    const client = new CloudApi(next);
    if (login.trim()) await client.verifyHouseholdLogin(login.trim());
    const nextStatus = await client.status();
    if (currentConnection.current !== connection) return;
    saveConnection(next);
    installSession(next, nextStatus);
    setInvitation(undefined);
    setNotice({ text: t(MSG.CONNECTION_SAVED_NOTICE) });
    if (location.state?.returnTo) void navigate(location.state.returnTo, { replace: true });
    else if (invitation || nextStatus.account?.role === 'member') navigate(appPaths.control, { replace: true });
  });

  const nameOwner = async (name: string, login: string) => {
    const updated = await api.nameHouseholdOwner(name, login);
    if (currentConnection.current === connection) setStatus((current) => (current ? { ...current, account: updated } : null));
  };

  const saveCode = (code: string) => run(async () => {
    if (!code.trim()) throw new Error(t(MSG.ENTER_YOUR_USER_CODE));
    const saved = await api.saveCode(code.trim());
    if (currentConnection.current !== connection) return;
    rotateCloudAccountScope(api, 'sharing');
    setStatus((current) => (current ? { ...current, ...saved } : null));
    setEditingCode(false); setQR(null);
    setNotice({ text: saved.saved_user_code_requires_login ? t(MSG.USER_CODE_SAVED) : t(MSG.USER_CODE_SAVED_ON_THE_SERVER) });
  }, true);

  const saveDeveloper = (credentials: DeveloperCredentials) => run(async () => {
    if (!credentials.access_id || !credentials.access_secret) throw new Error(t(MSG.ENTER_YOUR_ACCESS_ID_AND_ACCESS_SECRET));
    const saved = await api.saveDeveloper(credentials);
    if (currentConnection.current !== connection) return;
    rotateCloudAccountScope(api, 'developer');
    setStatus((current) => (current ? { ...current, developer: saved } : null));
    setEditingDeveloper(false);
    setNotice({ text: t(MSG.CREDENTIALS_SAVED_ON_THE_SERVER) });
  }, true);

  const connectDeveloper = () => run(async () => {
    const saved = await api.connectDeveloper();
    if (currentConnection.current !== connection) return;
    rotateCloudAccountScope(api, 'developer');
    setStatus((current) => (current ? { ...current, developer: saved } : null));
    setNotice({ text: t(MSG.TUYA_DEVELOPER_CONNECTED_DEVICE_COUNT, [saved.device_count ?? 0]) });
  }, true);

  const beginQR = () => run(async () => {
    setQR(null);
    const login = await api.beginQR();
    if (currentConnection.current !== connection) return;
    const image = await api.qrImage(login);
    if (currentConnection.current !== connection) return;
    const seconds = Number.isFinite(login.expires_in) ? Math.min(120, Math.max(1, login.expires_in)) : 120;
    setQR({ session: login.session_id, imageUrl: URL.createObjectURL(image), expiresAt: Date.now() + seconds * 1000 });
    setNotice({ text: t(MSG.SCAN_THE_CODE_IN_SMART_LIFE_TUYA_SMART) });
  }, true);

  const confirmQR = () => run(async () => {
    if (!qr) return;
    await api.confirmQR(qr.session);
    if (currentConnection.current !== connection) return;
    rotateCloudAccountScope(api, 'sharing');
    const nextStatus = await api.status();
    if (currentConnection.current !== connection) return;
    setQR(null);
    setStatus(nextStatus);
    setNotice({ text: t(MSG.ACCOUNT_CONNECTED) });
  }, true);

  function chooseProvider(value: Provider) {
    if (busyRef.current || value === provider) return;
    setQR(null); setNotice({ text: '' });
    void navigate(appPaths.connections + (value === 'developer' ? '?provider=developer' : ''), { state: location.state });
  }

  function changeCardSize(next: CardSize) {
    setCardSize(next);
    try { localStorage.setItem(CARD_SIZE_STORAGE_KEY, next); } catch { /* The current view still updates. */ }
  }

  function goTo(next: View) {
    setMenuOpen(false); setNotice({ text: '' });
    if (location.pathname !== appPaths[next] || location.search || location.hash) void navigate(appPaths[next]);
  }
  function changeDashboardPanel(next: DashboardPanel) {
    if (next !== 'search' && query.has('q')) { query.delete('q'); query.delete('page'); }
    void navigate(dashboardHref(dashboardRoom(location.pathname, query), query, next));
    setMenuOpen(false);
  }
  useEffect(() => { setMenuOpen(false); }, [location.key]);
  useEffect(() => { setQR(null); }, [view, provider]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);

  function signOut() {
    invalidateConnection();
    setNotice({ text: '' });
    navigate(appPaths.connections, { replace: true });
  }

  let connectionTitle = t(MSG.ACCOUNT_SIGN_IN);
  let connectionHint = t(MSG.ACCOUNT_SIGN_IN_HELP);
  if (member && !invitation) {
    connectionTitle = t(MSG.SERVICE_ACCESS);
    connectionHint = '';
  } else if (showIntegration && !invitation) {
    connectionTitle = t(ready && accountConnected ? MSG.TUYA_CONNECTED : MSG.CONNECT_TUYA);
    connectionHint = t(ready && accountConnected ? MSG.YOUR_SAVED_CONNECTION_IS_READY_TO_CONTROL_DEVICES : MSG.CONNECT_YOUR_ACCOUNT_TO_ACCESS_YOUR_DEVICES);
  }

  const accountName = identity?.name;
  const sessionControls = !demo && status && connection.token && (
    <div className="actions">
      {accountName && <span>{t(MSG.SIGNED_IN_AS, [accountName])}</span>}
      <button type="button" className="secondary compact" disabled={locked} onClick={signOut}>
        {t(MSG.SIGN_OUT)}
      </button>
    </div>
  );

  const controlCenter = (
    <ControlCenter
      key={sessionRevision}
      dashboardPanel={dashboardPanel}
      cardSize={cardSize}
      api={api}
      ready={Boolean(status && connection.token)}
      sharingReady={Boolean(ready && status?.connected)}
      developerReady={Boolean(ready && developer.connected)}
      onAuthError={invalidateConnection}
      onConnections={member ? undefined : () => goTo('connections')}
    />
  );
  const regionName = REGIONS.find((item) => item.value === developer.region)?.label;
  const appearance = (
    <>
      <ThemeSelector />
      <LanguageSelector />
      <DeviceTextModeSelector />
      <label>
        <span>{t(MSG.CARD_SIZE)}</span>
        <select value={cardSize} onChange={(event) => changeCardSize(event.target.value === 'small' ? 'small' : 'large')}>
          <option value="large">{t(MSG.CARD_SIZE_LARGE)}</option>
          <option value="small">{t(MSG.CARD_SIZE_SMALL)}</option>
        </select>
      </label>
    </>
  );
  return (
    <div className={"app-shell" + (view === 'control' ? " dashboard-view" : "")}
      data-dashboard-panel={dashboardPanel ?? undefined} data-card-size={cardSize}
    >
      <header className="app-header">
        <div className="app-menu" ref={menuRef} onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } }}>
          <button className="secondary app-menu-button" ref={menuButton} aria-label={t(MSG.MENU)} aria-expanded={menuOpen} aria-controls="app-sections" disabled={locked} onClick={() => setMenuOpen(value => !value)}>
            <IconGlyph name="menu" />
          </button>
          {menuOpen && (
          <nav id="app-sections" className="app-menu-panel" aria-label={t(MSG.APP_NAVIGATION)}>
            {([
              ['control', t(MSG.CONTROL)],
              ['combined-devices', t(MSG.COMBINED_DEVICES)],
              ['network', t(MSG.NETWORK_AND_PACKETS)],
              ['local-connections', t(MSG.LOCAL_CONNECTIONS)],
              ['settings', t(MSG.SETTINGS)],
              ['users', t(member ? MSG.MY_DEVICE_KEYS : MSG.USERS)],
              ['connections', t(MSG.CONNECTIONS)],
            ] as const).filter(([key]) => (
              (!demo || key === 'control' || key === 'settings') && (!member || !ownerPage(key)) && (key !== 'users' || Boolean(identity))
            )).map(([key, label]) => (
              <button type="button" key={key} className="secondary" aria-current={view === key ? 'page' : undefined} disabled={locked} onClick={() => goTo(key)}>
                {label}
              </button>
            ))}
            {view === 'control' && status && (
            <button className="secondary dashboard-tools-menu" disabled={locked} aria-expanded={dashboardPanel === 'tools'} onClick={() => {
          changeDashboardPanel(dashboardPanel === 'tools' ? null : 'tools');
          menuButton.current?.focus();
        }}
            >{t(MSG.DASHBOARD_SETTINGS)}
            </button>
)}
            {view !== 'settings' && <div className="app-menu-appearance">{appearance}</div>}
          </nav>
)}
        </div>
        <div className="brand">
          <IconGlyph name="home" className="brand-icon" />
          <div>
            <strong>Smart Home</strong>
            <span className="brand-tagline">{t(MSG.YOUR_HOME_UNDER_CONTROL)}</span>
            {view === 'control' && (
            <span className={"dashboard-connection" + (status ? " online" : "")}>
              <i aria-hidden="true" />{status ? t(MSG.CONNECTED) : t(MSG.API_DISCONNECTED)}
            </span>
)}
          </div>
        </div>
        <span className={'api-presence ' + (status ? 'online' : '')}>
          <i aria-hidden="true" />{status ? t(MSG.API_CONNECTED) : t(MSG.API_DISCONNECTED)}
        </span>
        {view === 'control' && status && (
        <button className="secondary dashboard-search-button" type="button" aria-label={t(MSG.SEARCH)} aria-expanded={dashboardPanel === 'search'} aria-controls="dashboard-search" disabled={locked} onClick={() => {
        changeDashboardPanel(dashboardPanel === 'search' ? null : 'search');
      }}
        >
          <Icon name="search" />
        </button>
)}
      </header>
      <main>
        {demo && <p className="eyebrow">Interactive demo · Simulated apartment · Reload to reset</p>}
        <Outlet
          context={{ view, pages: { connections: <>
            <div className="page-heading">
              <p className="eyebrow">{t(MSG.CONNECTIONS)}</p>
              <h1>{connectionTitle}</h1>
              {connectionHint && <p className="muted">{connectionHint}</p>}
            </div>
            {showIntegration && !invitation && (
            <div className="workspace connections-workspace">
              <section className="card setup" aria-label={t(MSG.TUYA_CONNECTION)}>
                <div className="method-tabs" role="group" aria-label={t(MSG.CONNECTION_METHOD)}>
                  <button aria-pressed={provider === 'sharing'} disabled={locked} onClick={() => chooseProvider('sharing')}>Smart Life / QR</button>
                  <button aria-pressed={provider === 'developer'} disabled={locked} onClick={() => chooseProvider('developer')}>Access ID / Secret</button>
                </div>
                {provider === 'sharing' ? (
                  <div className="provider-panel">
                    <p className="eyebrow">{t(MSG.SIGN_IN_WITH_THE_APP)}</p>
                    <h2>Smart Life / Tuya Smart</h2>
                    <p className="muted">{ready && status?.connected ? t(MSG.YOUR_TUYA_ACCOUNT_IS_CONNECTED) : t(MSG.SAVE_YOUR_USER_CODE_THEN_CONFIRM_SIGN_IN)}</p>
                    {!ready ? <p className="saved-summary">{status && !status.enabled ? t(MSG.CLOUD_MODE_IS_DISABLED_ON_THE_SERVER) : t(MSG.SAVE_API_ACCESS_IN_CONNECTION_SETTINGS_FIRST)}</p> : (
                  <>
                      {showCodeForm ? <UserCodeForm busy={busy} canCancel={Boolean(status?.has_saved_user_code)} onSave={saveCode} onCancel={() => setEditingCode(false)} /> : (
                        <p className="saved-summary">{t(MSG.USER_CODE_SAVED_ON_THE_SERVER) + " "}
                          <a href="#user-code" aria-controls="user-code" aria-expanded={false} aria-disabled={busy} onClick={event => {
                event.preventDefault(); if (!busyRef.current) { setEditingCode(true); setQR(null); setNotice({ text: '' }); }
              }}
                        >{t(MSG.EDIT)}
                          </a>
                        </p>
            )}
                      {status?.saved_user_code_requires_login && !showCodeForm && <p className="help">{t(MSG.CONFIRM_QR_SIGN_IN_FOR_THIS_USER_CODE)}</p>}
                  </>
          )}
                    <button className="full-width" disabled={busy || !ready || !status?.has_saved_user_code || showCodeForm} onClick={beginQR}>{t(MSG.GET_QR_CODE)}</button>
                    {qr && (
                  <div className="qr-panel">
                    <img src={qr.imageUrl} alt={t(MSG.QR_CODE_FOR_TUYA_SIGN_IN)} />
                    <p className="help">{t(MSG.SCAN_THE_CODE_IN_THE_APP) + " "}{remaining}{" " + t(MSG.SEC)}</p>
                    <button className="full-width" disabled={busy || !ready || remaining === 0} onClick={confirmQR}>{t(MSG.I_CONFIRMED_SIGN_IN_IN_THE_APP)}</button>
                  </div>
)}
                  </div>
) : (
  <div className="provider-panel">
    <p className="eyebrow">{t(MSG.SIGN_IN_WITH_A_CLOUD_PROJECT)}</p>
    <h2>Tuya Developer</h2>
    <p className="muted">{t(MSG.YOUR_SMART_LIFE_ACCOUNT_MUST_BE_LINKED_TO)}</p>
    {!ready ? <p className="saved-summary">{status && !status.enabled ? t(MSG.CLOUD_MODE_IS_DISABLED_ON_THE_SERVER) : t(MSG.SAVE_API_ACCESS_IN_CONNECTION_SETTINGS_FIRST)}</p> : (
      <>
        {showDeveloperForm ? <DeveloperForm region={developer.region} busy={busy} canCancel={developer.configured} onSave={saveDeveloper} onCancel={() => setEditingDeveloper(false)} /> : (
          <p className="saved-summary">{developer.connected ? t(MSG.CONNECTION_VERIFIED) : t(MSG.CREDENTIALS_SAVED)} {regionName}{". "}
            <a href="#developer-form" aria-controls="developer-form" aria-expanded={false} aria-disabled={busy} onClick={event => {
                event.preventDefault(); if (!busyRef.current) { setEditingDeveloper(true); setNotice({ text: '' }); }
              }}
            >{t(MSG.EDIT)}
            </a>
          </p>
            )}
      </>
          )}
    <button className="full-width" disabled={busy || !ready || !developer.configured || showDeveloperForm} onClick={connectDeveloper}>{t(MSG.CHECK_AND_CONNECT)}</button>
    <p className="help">{t(MSG.ACCESS_DEPENDS_ON_YOUR_TUYA_PROJECTS_API_PERMISSIONS)}</p>
  </div>
        )}
                <div className="privacy-note">
                  <IconGlyph name="check" />
                  <p>{t(MSG.USER_CODE_TUYA_CREDENTIALS_TOKENS_AND_LOCAL_KEYS)}</p>
                </div>
              </section>
            </div>
            )}
            <ConnectionSettings connection={connection} busy={locked} invitation={invitation} onSave={saveAccess} />
            {sessionControls}
          </>,
        settings: <section className="card">
          <h1>{t(MSG.SETTINGS)}</h1>
          <div className="app-menu-appearance">{appearance}</div>
          {sessionControls}
          {identity && <button type="button" className="secondary compact" onClick={() => goTo('users')}>{t(member ? MSG.MY_DEVICE_KEYS : MSG.USERS)}</button>}
        </section>,
          users: identity ? (
            <HouseholdAccess
              key={sessionRevision}
              api={api}
              account={identity}
              onAuthError={invalidateConnection}
              onNameOwner={nameOwner}
            />
          ) : null,
        network: <NetworkPage api={api} ready={Boolean(status && connection.token)} onAuthError={invalidateConnection} />,
        'local-connections': <LocalConnectionsPage api={api} ready={ready} sharingReady={Boolean(ready && status?.connected)} developerReady={Boolean(ready && developer.connected)} onAuthError={invalidateConnection} onLock={setLocalConnectionLocked} onConnections={() => goTo('connections')} />,
        control: controlCenter,
          rooms: <RoomEditor api={api} ready={Boolean(status && connection.token)} onAuthError={invalidateConnection} />,
          'combined-devices': controlCenter,
      } satisfies Record<View, ReactNode> }}
        />
        <div className={'notice ' + (notice.error ? 'error' : '')} role={notice.error ? 'alert' : 'status'} aria-live="polite">
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" />{t(MSG.PLEASE_WAIT)}
            </>
) : translateText(notice.text)}
        </div>
      </main>
      <footer>
        <span>ChmuraRezechy(c) 2026</span>
      </footer>
    </div>
  );
}
