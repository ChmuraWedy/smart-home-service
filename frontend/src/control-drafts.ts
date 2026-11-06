import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonValue } from './api';
import type { ControlSpec } from './controls';

export type ControlDraft = { spec: ControlSpec; value?: JsonValue; error?: string; begin: () => () => void };
export type DraftStage = (key: string, draft: ControlDraft | null) => void;

/** Coalesce slider/typing edits; discrete controls are sent on the next task.
 * A failed command is consumed, never retried by a timer or a status report.
 */
export function useAutomaticControls(send: (changes: ControlDraft[]) => Promise<boolean | void>, enabled: boolean) {
  const pending = useRef(new Map<string, ControlDraft>());
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    const drafts = pending.current;
    return () => drafts.clear();
  }, []);
  const [revision, setRevision] = useState(0);
  const stage = useCallback<DraftStage>((key, draft) => {
    const removed = pending.current.delete(key);
    if (draft) pending.current.set(key, draft);
    else if (!removed) return;
    setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const changes = [...pending.current.values()].filter(change => !change.error && change.value !== undefined);
    if (!changes.length) return;
    const delay = changes.some(change => ['boolean', 'enum'].includes(change.spec.kind)) ? 0 : 350;
    const timer = setTimeout(() => {
      for (const change of changes) if (pending.current.get(change.spec.key) === change) pending.current.delete(change.spec.key);
      const acknowledge = changes.map(change => change.begin());
      void latest.current(changes).then(accepted => {
        if (accepted === true) for (const record of acknowledge) record();
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [revision, enabled]);
  return { stage };
}
