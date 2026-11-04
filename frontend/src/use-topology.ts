import { t } from "./i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import type { HomeApi, Topology } from './home-api';

export function useTopology(api: HomeApi, ready: boolean, onSynced: () => void, onAuthError: () => void) {
  const [record, setRecord] = useState<{ api: HomeApi; data?: Topology; error?: string; starting?: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const starting = useRef<AbortController | null>(null), completion = useRef(false);
  const callbacks = useRef({ onSynced, onAuthError });
  callbacks.current = { onSynced, onAuthError };
  const current = ready && record?.api === api ? record : null;
  useEffect(() => {
    if (!ready) { setRecord(null); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, wasRunning = false;
    async function read() {
      try {
        const data = await api.topology(controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.placements) || !data.job) throw new Error(t("Не удалось прочитать структуру дома."));
        setRecord({ api, data });
        if (data.job.status === 'running') {
          wasRunning = true;
          timer = setTimeout(() => void read(), 1000);
        } else if ((wasRunning || completion.current) && data.job.status === 'done') {
          completion.current = false;
          callbacks.current.onSynced();
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setRecord(previous => ({ ...(previous?.api === api ? previous : {}), api, starting: false, error: failure instanceof Error ? failure.message : t("Не удалось прочитать структуру дома.") }));
        if (failure instanceof ApiError && failure.status === 401) callbacks.current.onAuthError();
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, ready, revision]);
  useEffect(() => () => { starting.current?.abort(); completion.current = false; }, [api, ready]);

  async function sync() {
    if (!ready || current?.starting) return;
    setRecord(previous => ({ ...(previous?.api === api ? previous : {}), api, starting: true, error: undefined }));
    const controller = new AbortController(); starting.current = controller;
    try {
      await api.syncTopology(controller.signal);
      if (controller.signal.aborted) return;
      // Reload once even if the job finishes before our first progress read.
      completion.current = true;
      setRevision(value => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setRecord(previous => ({ ...(previous?.api === api ? previous : {}), api, starting: false, error: failure instanceof Error ? failure.message : t("Не удалось начать синхронизацию.") }));
      if (failure instanceof ApiError && failure.status === 401) callbacks.current.onAuthError();
    }
  }
  return { data: current?.data, error: current?.error, busy: Boolean(current?.starting || (!current?.error && current?.data?.job.status === 'running')), sync };
}
