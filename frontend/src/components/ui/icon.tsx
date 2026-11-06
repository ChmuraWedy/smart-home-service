import type { ReactNode } from 'react';

const drawings = {
  add: <path d="M12 5v14M5 12h14" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  delete: <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" />,
  edit: (
    <>
      <path d="m16 3 5 5-12 12-6 1 1-6Z" />
      <path d="m14 5 5 5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  'refresh-list': <path d="M20 4v5h-5M20 9a8 8 0 1 0 0 6" />,
  'refresh-status': <path d="M20 7v5h-5M20 12a8 8 0 1 1-2.4-5.7L20 9" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  settings: (
    <>
      <path d="M10 3h4l.6 2.7 1.9 1.1 2.6-.9 2 3.5-2 1.8v2.2l2 1.8-2 3.5-2.6-.9-1.9 1.1L14 21h-4l-.6-2.7-1.9-1.1-2.6.9-2-3.5 2-1.8v-2.2l-2-1.8 2-3.5 2.6.9 1.9-1.1L10 3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  shield: <path d="M12 3 4.5 6v5.5c0 4.2 3 7.5 7.5 9.5 4.5-2 7.5-5.3 7.5-9.5V6z" />,
  wifi: (
    <>
      <path d="M3 9a15 15 0 0 1 18 0M6 13a10 10 0 0 1 12 0M9 17a5 5 0 0 1 6 0" />
      <circle cx="12" cy="21" r=".5" />
    </>
  ),
};

type IconName = keyof typeof drawings;

export function IconSvg({ children, className, name, deviceType }: {
  children: ReactNode;
  className?: string;
  name?: IconName;
  deviceType?: string;
}) {
  return (
    <svg
      className={className ? 'ui-icon ' + className : 'ui-icon'}
      data-icon={name}
      data-device-type={deviceType}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <IconSvg className={className} name={name}>{drawings[name]}</IconSvg>;
}

const glyphs = {
  add: '+',
  check: '✓',
  close: '×',
  fullscreen: '⛶',
  home: '⌂',
  info: 'i',
  menu: '☰',
  more: '…',
  'more-centered': '···',
  play: '▷',
  refresh: '↻',
  resize: '↘',
  'video-blocked': '▣',
};

export function IconGlyph({ name, className }: { name: keyof typeof glyphs; className?: string }) {
  return <span className={className} aria-hidden="true">{glyphs[name]}</span>;
}
