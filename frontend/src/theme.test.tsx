import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bootstrapHTML from '../index.html?raw';

let theme: typeof import('./theme');
let App: typeof import('./test/App')['App'];
const media = Object.assign(new EventTarget(), { matches: false });
const systemChange = (dark: boolean) => {
  media.matches = dark;
  act(() => { media.dispatchEvent(new Event('change')); });
};

beforeAll(async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => media });
  theme = await import('./theme');
  App = (await import('./test/App')).App;
});
beforeEach(() => {
  media.matches = false;
  theme.setTheme('system', false);
  document.head.innerHTML = '<meta name="theme-color" content="#f3f6fa">';
});

describe('appearance preferences', () => {
  it('defaults to System and follows OS changes only in System mode', () => {
    expect(theme.savedTheme()).toBe('system');
    expect(theme.getTheme()).toBe('system');
    expect(theme.resolvedTheme()).toBe('day');
    systemChange(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta[name=theme-color]')).toHaveAttribute('content', '#101720');
    theme.setTheme('day');
    systemChange(false); systemChange(true);
    expect(document.documentElement.dataset.theme).toBe('day');
    theme.setTheme('dark'); systemChange(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.setTheme('system');
    expect(document.documentElement.dataset.theme).toBe('day');
  });

  it.each(['system','dark','day'] as const)('saves %s without touching connection or language', choice => {
    localStorage.setItem('smart-home.ui.connection.v1', 'unchanged-connection-fixture');
    localStorage.setItem('smart-home.ui.language.v1', 'be');
    theme.setTheme(choice);
    expect(theme.savedTheme()).toBe(choice);
    expect(document.documentElement.dataset.themePreference).toBe(choice);
    expect(localStorage.getItem('smart-home.ui.connection.v1')).toBe('unchanged-connection-fixture');
    expect(localStorage.getItem('smart-home.ui.language.v1')).toBe('be');
  });

  it('accepts cross-tab changes and falls back to System when the preference is removed', () => {
    window.history.replaceState(null, '', '/settings/connections');
    render(<App/>);
    fireEvent.click(screen.getByRole('button',{name:'Меню'}));
    act(()=>window.dispatchEvent(new StorageEvent('storage', {key:theme.THEME_STORAGE_KEY,newValue:'dark'})));
    expect(screen.getByLabelText('Тема')).toHaveValue('dark');
    systemChange(true);
    act(()=>window.dispatchEvent(new StorageEvent('storage', {key:theme.THEME_STORAGE_KEY,newValue:null})));
    expect(screen.getByLabelText('Тема')).toHaveValue('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(()=>window.dispatchEvent(new StorageEvent('storage', {key:theme.THEME_STORAGE_KEY,newValue:'invalid'})));
    expect(theme.getTheme()).toBe('system');
  });

  it('keeps switching usable when storage is blocked', () => {
    const read=vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
    const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});
    try {
      expect(theme.savedTheme()).toBe('system');
      expect(()=>theme.setTheme('dark')).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  it('offers appearance preferences in the menu before connecting and preserves a live API/key draft', () => {
    window.history.replaceState(null, '', '/settings/connections');
    render(<App/>);
    const address=screen.getByLabelText('Адрес API');
    const key=screen.getByLabelText('Ключ доступа к сервису');
    fireEvent.change(address,{target:{value:'http://draft-api.test:8080'}});
    fireEvent.change(key,{target:{value:'чернавік-Łąka'}});
    const menu = screen.getByRole('button',{name:'Меню'});
    expect(screen.queryByLabelText('Тема')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Язык')).not.toBeInTheDocument();
    fireEvent.click(menu);
    for (const choice of ['dark','day','system']) {
      fireEvent.change(screen.getByLabelText('Тема'),{target:{value:choice}});
      expect(screen.getByLabelText('Адрес API')).toBe(address);
      expect(address).toHaveValue('http://draft-api.test:8080');
      expect(key).toHaveValue('чернавік-Łąka');
    }
    fireEvent.change(screen.getByLabelText('Язык'),{target:{value:'pl'}});
    expect(screen.getByLabelText('Motyw')).toHaveValue('system');
    expect(screen.getByRole('option',{name:'Dzienny'})).toHaveValue('day');
    fireEvent.change(screen.getByLabelText('Język'),{target:{value:'be'}});
    expect(screen.getByLabelText('Тэма')).toHaveValue('system');
    expect(screen.getByRole('option',{name:'Цёмная'})).toHaveValue('dark');
    fireEvent.keyDown(screen.getByLabelText('Тэма'),{key:'Escape'});
    expect(menu).toHaveFocus();
    expect(menu).toHaveAttribute('aria-expanded','false');
    expect(key).toHaveValue('чернавік-Łąka');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('changes card size immediately and restores the saved selection on remount', () => {
    window.history.replaceState(null, '', '/settings/connections');
    const first = render(<App />);
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Меню' }));
    openMenu();
    const size = screen.getByLabelText('Размер карточек');
    expect(size).toHaveValue('large');
    expect(first.container.firstElementChild).toHaveAttribute('data-card-size', 'large');
    fireEvent.change(size, { target: { value: 'small' } });
    expect(first.container.firstElementChild).toHaveAttribute('data-card-size', 'small');
    first.unmount();
    const second = render(<App />);
    openMenu();
    expect(screen.getByLabelText('Размер карточек')).toHaveValue('small');
    expect(second.container.firstElementChild).toHaveAttribute('data-card-size', 'small');
    fireEvent.change(screen.getByLabelText('Размер карточек'), { target: { value: 'large' } });
    expect(second.container.firstElementChild).toHaveAttribute('data-card-size', 'large');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies the persisted choice before React paints', () => {
    const script=bootstrapHTML.match(/<script>([\s\S]*?)<\/script>/)![1];
    localStorage.setItem(theme.THEME_STORAGE_KEY,'dark');
    new Function(script)();
    expect(document.documentElement.dataset.theme).toBe('dark');
    localStorage.setItem(theme.THEME_STORAGE_KEY,'day');
    new Function(script)();
    expect(document.documentElement.dataset.theme).toBe('day');
    localStorage.setItem(theme.THEME_STORAGE_KEY,'invalid');
    media.matches=true;
    new Function(script)();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('system');
  });
});
