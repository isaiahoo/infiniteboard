// Minimal line icons drawn for this project (24×24 grid, currentColor).

const P = (props: { d: string; fill?: boolean }) => (
  <path d={props.d} fill={props.fill ? "currentColor" : "none"} stroke={props.fill ? "none" : "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
);

export const icons = {
  select: <P d="M5 3l14 8-6 1.5L10 19z" />,
  hand: <P d="M8 12V5.5a1.5 1.5 0 013 0V11m0-6.5a1.5 1.5 0 013 0V11m0-5a1.5 1.5 0 013 0v7c0 4-2.5 7-6.5 7S6 18 4.5 15.5L3 13a1.5 1.5 0 012.5-1.6L8 14" />,
  text: <P d="M5 6V4h14v2M12 4v16M9 20h6" />,
  sticky: <P d="M4 4h16v10l-6 6H4zM14 20v-6h6" />,
  rect: <P d="M4 6h16v12H4z" />,
  roundrect: <P d="M8 5h8a4 4 0 014 4v6a4 4 0 01-4 4H8a4 4 0 01-4-4V9a4 4 0 014-4z" />,
  ellipse: <P d="M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z" />,
  diamond: <P d="M12 3l9 9-9 9-9-9z" />,
  triangle: <P d="M12 4l9 16H3z" />,
  frame: <P d="M7 3v18M17 3v18M3 7h18M3 17h18" />,
  arrow: <P d="M5 19L19 5M10 5h9v9" />,
  pen: <P d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4" />,
  marker: <P d="M9 15l-4 5h6l2-3M9 15l8-11 4 3-8 11zM9 15l4 3" />,
  eraser: <P d="M8 20h12M5 15l9-10 6 6-8 9H8z" />,
  image: <P d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1 1 0 100-.01" />,
  undo: <P d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  redo: <P d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" />,
  minus: <P d="M6 12h12" />,
  plus: <P d="M6 12h12M12 6v12" />,
  fit: <P d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  menu: <P d="M4 7h16M4 12h16M4 17h16" />,
  map: <P d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />,
  help: <P d="M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />,
  ai: <P d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />,
  trash: <P d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  copy: <P d="M8 8h11v11H8zM5 16V5h11" />,
  front: <P d="M8 8h11v11H8zM5 5h9v2M5 5v9h2" />,
  back: <P d="M5 5h11v11H5zM19 9v10H9" />,
  lock: <P d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" />,
  unlock: <P d="M6 11h12v9H6zM8 11V8a4 4 0 017.5-2" />,
  bold: <P d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z" />,
  italic: <P d="M10 4h8M6 20h8M14 4l-4 16" />,
  alignLeft: <P d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCenter: <P d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignRight: <P d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  straight: <P d="M4 20L20 4" />,
  elbow: <P d="M4 20v-8h16V4" />,
  curved: <P d="M4 20C4 8 20 16 20 4" />,
  headNone: <P d="M4 12h16" />,
  headOpen: <P d="M4 12h16M14 6l6 6-6 6" />,
  headFilled: (
    <>
      <P d="M4 12h12" />
      <P d="M14 6l6 6-6 6z" fill />
    </>
  ),
  dashSolid: <P d="M3 12h18" />,
  dashDashed: <P d="M3 12h4M10 12h4M17 12h4" />,
  dashDotted: <P d="M4 12h.01M8 12h.01M12 12h.01M16 12h.01M20 12h.01" />,
};

export type IconName = keyof typeof icons;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}
