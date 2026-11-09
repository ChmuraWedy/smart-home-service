import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import type { SyntheticEvent } from 'react';
import { matchPath, useLocation } from 'react-router';
import {
  appPaths, combinationNewPath, combinationNewPreviewPath, roomLayoutPattern, roomPattern,
} from '../navigation';
import { MSG, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { Icon } from './ui/icon';

const steps = [
  { selector: '.app-menu-button', title: MSG.MENU, body: MSG.TUTORIAL_MENU_BUTTON_BODY },
  {
    selector: '#app-sections', title: MSG.APP_NAVIGATION, body: MSG.TUTORIAL_MENU_BODY, menu: true,
  },
  { selector: '.room-navigation-bar, .room-navigation-trigger', title: MSG.TUTORIAL_ROOMS, body: MSG.TUTORIAL_ROOMS_BODY },
  { selector: '.dashboard-search-button', title: MSG.SEARCH, body: MSG.TUTORIAL_ROOMS_TIP },
  { selector: 'li[id^="device-"] .dashboard-power-button:not([disabled])', title: MSG.POWER, body: MSG.TUTORIAL_POWER_BODY },
  { selector: '[data-tour="device-settings"]', title: MSG.DETAILS, body: MSG.TUTORIAL_DETAILS_BODY },
  { selector: '[data-tour="chat"]', title: MSG.AI_CHAT_TITLE, body: MSG.TUTORIAL_CHAT_BODY },
];

function visibleTarget(selector: string) {
  return selector.split(',')
    .flatMap((candidate) => Array.from(document.querySelectorAll(candidate)))
    .find((element) => element.getClientRects().length > 0);
}

function spotlightRect(element: Element) {
  const bounds = element.getBoundingClientRect();
  const left = Math.max(4, bounds.left - 5);
  const top = Math.max(4, bounds.top - 5);
  return {
    left,
    top,
    width: Math.max(0, Math.min(window.innerWidth - 4, bounds.right + 5) - left),
    height: Math.max(0, Math.min(window.innerHeight - 4, bounds.bottom + 5) - top),
  };
}

type TourCallbacks = {
  onClose: () => void;
  onMenuChange: (menuVisible: boolean) => void;
};

function DashboardTourIntro({
  onClose, onMenuChange, onPractice, total,
}: TourCallbacks & { onPractice: () => void; total: number }) {
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const [spotlight, setSpotlight] = useState<{
    selector: string;
    bounds: ReturnType<typeof spotlightRect>;
  }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.querySelector<HTMLElement>('.app-menu-button')?.focus();
    };
  }, []);

  useEffect(() => {
    onMenuChange(Boolean(step.menu));
    return () => onMenuChange(false);
  }, [onMenuChange, step]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    let frame = 0;
    let target: Element | undefined;

    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = visibleTarget(step.selector);
        if (next && next !== target) {
          const bounds = next.getBoundingClientRect();
          if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) next.scrollIntoView({ block: 'center' });
        }
        target = next;
        setSpotlight(next ? { selector: step.selector, bounds: spotlightRect(next) } : undefined);
      });
    };

    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    refresh();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      cancelAnimationFrame(frame);
    };
  }, [step]);

  const cancelTour = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  }, [onClose]);

  const rect = spotlight?.selector === step.selector ? spotlight.bounds : undefined;
  let position = 'center';
  if (rect) position = rect.top > window.innerHeight / 2 ? 'top' : 'bottom';
  const last = index === steps.length - 1;
  return (
    <dialog
      ref={dialog}
      className="dashboard-tour"
      aria-labelledby="dashboard-tour-heading"
      aria-describedby="dashboard-tour-description"
      onCancel={cancelTour}
      data-spotlight={Boolean(rect)}
    >
      {rect && <span className="dashboard-tour-spotlight" style={rect} aria-hidden="true" />}
      <section
        className="card dashboard-tour-tip"
        data-position={position}
      >
        <div className="dashboard-tour-top">
          <p className="eyebrow">{t(MSG.TUTORIAL_PROGRESS, [index + 1, total])}</p>
          <button type="button" className="secondary compact" aria-label={t(MSG.CLOSE)} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <h2 id="dashboard-tour-heading" tabIndex={-1} ref={heading}>{t(step.title)}</h2>
        <p id="dashboard-tour-description">{t(step.body)}</p>
        <div className="dashboard-tour-actions">
          {index > 0 && <button type="button" className="secondary compact" onClick={() => setIndex(index - 1)}>{t(MSG.BACK)}</button>}
          <button type="button" className="compact" onClick={last ? onPractice : () => setIndex(index + 1)}>
            {t(MSG.NEXT)}
          </button>
        </div>
      </section>
    </dialog>
  );
}

const roomTargets = '.room-navigation-bar, .room-navigation-trigger';
const appMenuTargets = '[data-tour="combined-menu"], .app-menu-button';
const createTarget = '[data-tour="create-combination"]';
const wizardSelector = '[data-tour-combination-phase]';

function useCombinationPhase(pathname: string) {
  const [phase, setPhase] = useState<string | null>(null);

  useEffect(() => {
    if (pathname !== combinationNewPath) return undefined;
    const read = () => setPhase(document.querySelector(wizardSelector)?.getAttribute('data-tour-combination-phase') ?? null);
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['data-tour-combination-phase'],
    });
    read();
    return () => observer.disconnect();
  }, [pathname]);

  return phase;
}

function usePracticeHighlight(selector: string) {
  useEffect(() => {
    if (!selector) return undefined;
    let target: Element | undefined;

    function highlight() {
      const next = visibleTarget(selector);
      if (next === target) return;
      target?.removeAttribute('data-tour-highlight');
      target = next;
      target?.setAttribute('data-tour-highlight', '');
    }

    const observer = new MutationObserver(highlight);
    observer.observe(document.body, { subtree: true, childList: true });
    window.addEventListener('resize', highlight);
    highlight();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', highlight);
      target?.removeAttribute('data-tour-highlight');
    };
  }, [selector]);
}

function DashboardTourPractice({ canCombine, onClose, total }: {
  canCombine: boolean;
  onClose: () => void;
  total: number;
}) {
  const { pathname } = useLocation();
  const [combination, setCombination] = useState(false);
  const [openedEditor, setOpenedEditor] = useState(false);
  const [openedWizard, setOpenedWizard] = useState(false);
  const phase = useCombinationPhase(pathname);
  const namedRoom = /^\d+$/.test(matchPath(roomPattern, pathname)?.params.roomId ?? '');
  const inEditor = Boolean(matchPath(roomLayoutPattern, pathname));
  const inNewWizard = pathname === combinationNewPath || pathname === combinationNewPreviewPath;
  const inCombinationList = pathname === appPaths['combined-devices'];

  useEffect(() => {
    if (inEditor) setOpenedEditor(true);
    if (inNewWizard) setOpenedWizard(true);
  }, [inEditor, inNewWizard]);

  let description: MessageKey = MSG.TUTORIAL_PRACTICE_CHOOSE_ROOM;
  let selector = roomTargets;
  let complete = false;

  if (combination) {
    description = MSG.TUTORIAL_PRACTICE_OPEN_COMBINED;
    selector = appMenuTargets;
    if (inCombinationList) {
      complete = openedWizard;
      description = complete ? MSG.TUTORIAL_PRACTICE_COMBINED_DONE : MSG.TUTORIAL_PRACTICE_CREATE_COMBINED;
      selector = complete ? '' : createTarget;
    } else if (pathname === combinationNewPreviewPath) {
      description = MSG.TUTORIAL_PRACTICE_PREVIEW_COMBINED;
      selector = '.combined-preview';
    } else if (pathname === combinationNewPath) {
      description = phase === 'details' ? MSG.TUTORIAL_PRACTICE_NAME_COMBINED : MSG.TUTORIAL_PRACTICE_SELECT_COMBINED;
      selector = phase === 'details' ? '[data-tour-combination-phase] input[required]' : '.combined-members';
    }
  } else if (inEditor) {
    description = MSG.TUTORIAL_PRACTICE_USE_EDITOR;
    selector = '.dashboard-layout-toolbar[data-editing] .dashboard-layout-actions';
  } else if (namedRoom) {
    complete = openedEditor;
    description = complete ? MSG.TUTORIAL_PRACTICE_ROOM_DONE : MSG.TUTORIAL_PRACTICE_OPEN_EDITOR;
    selector = complete ? '' : '[data-tour="room-layout"]';
  }

  usePracticeHighlight(selector);

  const next = useCallback(() => {
    if (combination || !canCombine) onClose();
    else setCombination(true);
  }, [canCombine, combination, onClose]);

  const title = combination ? MSG.COMBINED_DEVICES : MSG.TUTORIAL_LAYOUT;
  const step = steps.length + (combination ? 2 : 1);
  const last = combination || !canCombine;
  let action: MessageKey = MSG.TUTORIAL_SKIP_STEP;
  if (complete) action = last ? MSG.DONE : MSG.NEXT;

  return (
    <aside className="card dashboard-tour-practice" aria-labelledby="tour-practice-title">
      <div className="dashboard-tour-top">
        <p className="eyebrow">{t(MSG.TUTORIAL_PROGRESS, [step, total])}</p>
        <button type="button" className="secondary compact" aria-label={t(MSG.CLOSE)} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div aria-live="polite">
        <h2 id="tour-practice-title">{t(title)}</h2>
        <p>{t(description)}</p>
      </div>
      <div className="dashboard-tour-actions">
        <button type="button" className="secondary compact" onClick={next}>{t(action)}</button>
      </div>
    </aside>
  );
}

export default function DashboardTour({ canCombine, onClose, onMenuChange }: TourCallbacks & { canCombine: boolean }) {
  const [practicing, setPracticing] = useState(false);
  const startPractice = useCallback(() => setPracticing(true), []);
  const total = steps.length + (canCombine ? 2 : 1);
  if (practicing) return <DashboardTourPractice canCombine={canCombine} onClose={onClose} total={total} />;
  return <DashboardTourIntro onClose={onClose} onMenuChange={onMenuChange} onPractice={startPractice} total={total} />;
}
