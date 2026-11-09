import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { HomeApi } from '../home-api';
import { MSG, t, useLocale } from '../i18n';
import { DashboardSheet } from './DashboardSheet';
import { Icon } from './ui/icon';

type ChatAccess = { api: HomeApi; onAuthError: () => void };

function trustedFrameUrl(value: string | null, ticket: string | null): string | null {
  if (!value || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  try {
    const url = new URL(value);
    const safe = url.protocol === 'https:' && url.origin !== window.location.origin
      && !url.username && !url.password && !url.search && !url.hash;
    if (safe) {
      url.hash = new URLSearchParams({ ticket }).toString();
      return url.href;
    }
  } catch { /* Treat invalid frame URLs as unavailable. */ }
  return null;
}

function ChatFrame({ api, onAuthError }: ChatAccess) {
  const [src, setSrc] = useState<string | null>();

  useEffect(() => {
    const controller = new AbortController();
    api.assistantEmbed(controller.signal).then(({ url, ticket }) => {
      if (!controller.signal.aborted) setSrc(trustedFrameUrl(url, ticket));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onAuthError();
      else setSrc(null);
    });
    return () => controller.abort();
  }, [api, onAuthError]);

  if (!src) {
    return <p role="status">{t(src === undefined ? MSG.AI_CHAT_LOADING : MSG.AI_CHAT_UNAVAILABLE)}</p>;
  }

  return (
    <iframe
      className="ai-chat-frame"
      src={src}
      title={t(MSG.AI_CHAT_TITLE)}
      allow="microphone"
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerPolicy="no-referrer"
    />
  );
}

export default function AiChatButton({ api, disabled, onAuthError }: ChatAccess & { disabled: boolean }) {
  useLocale();
  const [openFor, setOpenFor] = useState<HomeApi | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = openFor === api;
  const title = t(MSG.AI_CHAT_TITLE);

  return (
    <>
      <button
        type="button"
        className="secondary header-icon"
        ref={trigger}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpenFor(api)}
      >
        <Icon name="chat" />
      </button>
      {open && (
        <DashboardSheet title={title} onClose={() => setOpenFor(null)} returnFocus={trigger} className="ai-chat-sheet">
          <ChatFrame api={api} onAuthError={onAuthError} />
        </DashboardSheet>
      )}
    </>
  );
}
