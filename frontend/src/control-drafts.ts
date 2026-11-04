import { useCallback, useRef, useState } from 'react';
import type { JsonValue } from './api';
import type { ControlSpec } from './controls';

export type ControlDraft = { spec: ControlSpec; value?: JsonValue; error?: string; accept: (sentAt: number) => void };
export type DraftStage = (key: string, draft: ControlDraft | null) => void;

export function useControlDrafts() {
  const entries = useRef(new Map<string, ControlDraft>());
  const [summary, setSummary] = useState({ count: 0, invalid: false });
  const update = () => setSummary({ count: entries.current.size, invalid: [...entries.current.values()].some(entry => !!entry.error || entry.value === undefined) });
  const stage = useCallback<DraftStage>((key, draft) => {
    // Retain edit order so the latest light edit selects an implicit mode.
    entries.current.delete(key);
    if (draft) entries.current.set(key, draft);
    update();
  }, []);
  async function apply(send: (changes: ControlDraft[]) => Promise<boolean | void>) {
    const changes = [...entries.current.values()];
    if (!changes.length || changes.some(change => change.error || change.value === undefined)) return;
    const sentAt = Date.now();
    if (await send(changes) !== true) return;
    for (const change of changes) {
      change.accept(sentAt);
      if (entries.current.get(change.spec.key) === change) entries.current.delete(change.spec.key);
    }
    update();
  }
  return { stage, apply, ...summary };
}
