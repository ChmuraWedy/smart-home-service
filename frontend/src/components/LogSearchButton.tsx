import { useState } from 'react';
import type { CloudApi } from '../api';
import { MSG, t } from '../i18n';

export default function LogSearchButton({ api, disabled }: {api:CloudApi; disabled:boolean}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);

  async function open() {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError(true); return; }
    tab.opener = null;
    setOpening(true); setError(false);
    try {
      const result = await api.logSearchTicket();
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/session') {
        throw new Error('Invalid log search destination');
      }
      const form = tab.document.createElement('form');
      form.method = 'POST'; form.action = target.href;
      const input = tab.document.createElement('input');
      input.type = 'hidden'; input.name = 'ticket'; input.value = result.ticket;
      form.append(input); tab.document.body.append(form); form.submit();
    } catch {
      tab.close(); setError(true);
    } finally { setOpening(false); }
  }

  return (
    <>
      <button type="button" className="secondary" disabled={disabled || opening} onClick={open}>
        {t(MSG.LOG_SEARCH)}
      </button>
      {error && <p role="alert" className="error">{t(MSG.LOG_SEARCH_OPEN_FAILED)}</p>}
    </>
  );
}
