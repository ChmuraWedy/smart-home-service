import type { ReactNode } from 'react';

const drawings = {
  add: <path d="M12 5v14M5 12h14" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  chat: <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 3V6a1 1 0 0 1 1-1Zm3 5h8m-8 3h5" />,
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
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
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  'eye-off': <path d="m3 3 18 18M9 6.4a10 10 0 0 1 3-.4c6.5 0 10 6 10 6a16 16 0 0 1-3 3.4M6 7.8A17 17 0 0 0 2 12s3.5 6 10 6a11 11 0 0 0 4.2-.8" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  move: <path d="M12 3v18M3 12h18M9 6l3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3" />,
  room: <path d="M4 21h16M6 21V3h12v18m-4-8h1" />,
  'room-all': <path d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" />,
  'room-balcony': <path d="M5 10V4h14v6M3 11h18v9H3zm5 0v9m4-9v9m4-9v9M2 20h20" />,
  'room-bath': <path d="M3 12h18v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zm3 7-1 2m13-2 1 2M17 12V5a2 2 0 0 0-4 0v1" />,
  'room-bed': <path d="M3 20v-9m18 9v-5a3 3 0 0 0-3-3H3m0 6h18M5 12V8h5v4m0-3h8a2 2 0 0 1 2 2v2" />,
  'room-kitchen': <path d="M5 10h14v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zm-3 2h3m14 0h3M4 10h16M8 7h8m-4 0V4" />,
  'room-living': <path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3M5 11a2 2 0 0 0-2 2v5h18v-5a2 2 0 0 0-4 0v1H7v-1a2 2 0 0 0-2-2Zm0 7v2m14-2v2" />,
  'room-none': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  'room-study': <path d="M3 12h18M5 12v8m14-8v8M8 12V8l3-4 4 2-3 4H9m6-4 2 1" />,
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
  sliders: <path d="M4 7h6m4 0h6M4 12h10m4 0h2M4 17h2m4 0h10M10 5v4m4 1v4m-8 1v4" />,
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
};

export function IconGlyph({ name, className }: { name: keyof typeof glyphs; className?: string }) {
  return <span className={className} aria-hidden="true">{glyphs[name]}</span>;
}
