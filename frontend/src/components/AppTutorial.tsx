import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { MSG, t } from '../i18n';
import { appPaths } from '../navigation';
import { Icon } from './ui/icon';

const topics = [
  {
    id: 'rooms',
    icon: 'room-all',
    title: MSG.TUTORIAL_ROOMS,
    body: MSG.TUTORIAL_ROOMS_BODY,
    tip: MSG.TUTORIAL_ROOMS_TIP,
  },
  {
    id: 'controls',
    icon: 'sliders',
    title: MSG.TUTORIAL_CONTROLS,
    body: MSG.TUTORIAL_CONTROLS_BODY,
    tip: MSG.TUTORIAL_CONTROLS_TIP,
  },
  {
    id: 'layout',
    icon: 'edit',
    title: MSG.TUTORIAL_LAYOUT,
    body: MSG.TUTORIAL_LAYOUT_BODY,
    tip: MSG.TUTORIAL_LAYOUT_TIP,
  },
  {
    id: 'local',
    icon: 'wifi',
    title: MSG.LOCAL_CONNECTIONS,
    body: MSG.TUTORIAL_LOCAL_BODY,
    tip: MSG.TUTORIAL_LOCAL_TIP,
  },
  {
    id: 'chat',
    icon: 'chat',
    title: MSG.AI_CHAT_TITLE,
    body: MSG.TUTORIAL_CHAT_BODY,
    tip: MSG.TUTORIAL_CHAT_TIP,
  },
] as const;

function topicHref(topic: typeof topics[number]) {
  return topic === topics[0] ? appPaths.tutorial : `${appPaths.tutorial}?topic=${topic.id}`;
}

type Props = {
  onStart?: () => void;
  canOpenDashboard: boolean;
  canOpenLocalConnections: boolean;
};

export default function AppTutorial({ onStart, canOpenDashboard, canOpenLocalConnections }: Props) {
  const [params] = useSearchParams();
  const index = Math.max(0, topics.findIndex((topic) => topic.id === params.get('topic')));
  const current = topics[index];
  const previous = topics[index - 1];
  const next = topics[index + 1];
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, [current]);

  return (
    <section className="app-tutorial" aria-labelledby="app-tutorial-title">
      <header className="page-heading">
        <h1 id="app-tutorial-title">{t(MSG.APP_TUTORIAL)}</h1>
        <p className="muted">{t(MSG.TUTORIAL_INTRO)}</p>
        {onStart && <button type="button" onClick={onStart}>{t(MSG.TUTORIAL_START_TOUR)}</button>}
      </header>
      <nav aria-label={t(MSG.TUTORIAL_TOPICS)}>
        <ol className="app-tutorial-topics">
          {topics.map((topic) => (
            <li key={topic.id}>
              <Link to={topicHref(topic)} aria-current={current === topic ? 'step' : undefined}>
                <Icon name={topic.icon} />
                <span>{t(topic.title)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <article className="card app-tutorial-lesson" aria-labelledby="app-tutorial-topic">
        <p className="eyebrow">{t(MSG.TUTORIAL_PROGRESS, [index + 1, topics.length])}</p>
        <h2 id="app-tutorial-topic" ref={heading} tabIndex={-1}>{t(current.title)}</h2>
        <p>{t(current.body)}</p>
        <p className="app-tutorial-tip">
          <Icon name="info" />
          <span>{t(current.tip)}</span>
        </p>
        {current.id === 'local' && canOpenLocalConnections && (
          <Link className="app-tutorial-text-link" to={appPaths['local-connections']}>
            {t(MSG.TUTORIAL_OPEN_LOCAL)}
          </Link>
        )}
        <footer className="app-tutorial-actions">
          {previous && (
            <Link className="app-tutorial-action" to={topicHref(previous)}>{t(MSG.BACK)}</Link>
          )}
          {next ? (
            <Link className="app-tutorial-action" data-primary to={topicHref(next)}>{t(MSG.NEXT)}</Link>
          ) : (
            <Link className="app-tutorial-action" data-primary to={canOpenDashboard ? appPaths.control : appPaths.connections}>
              {t(canOpenDashboard ? MSG.TUTORIAL_OPEN_DASHBOARD : MSG.CONNECT_TUYA)}
            </Link>
          )}
        </footer>
      </article>
    </section>
  );
}
