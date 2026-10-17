// Stroke icons (24x24), built with createElementNS: no HTML strings.

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  spark: [['path', { d: 'M12 2.5l1.9 6.1a2 2 0 0 0 1.4 1.4l6.2 2-6.2 2a2 2 0 0 0-1.4 1.4L12 21.5l-1.9-6.1a2 2 0 0 0-1.4-1.4L2.5 12l6.2-2a2 2 0 0 0 1.4-1.4z', fill: 'currentColor', stroke: 'none' }]],
  sliders: [['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }], ['circle', { cx: 15, cy: 6, r: 2 }],
    ['circle', { cx: 9, cy: 12, r: 2 }], ['circle', { cx: 17, cy: 18, r: 2 }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h9' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4' }]],
  book: [['path', { d: 'M2.5 5h6.5a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5h-7zM21.5 5H15a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5h7z' }]],
  text: [['path', { d: 'M5 7V5h14v2M12 5v14M9 19h6' }]],
  chat: [['path', { d: 'M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.5A8.5 8.5 0 1 1 20.5 12z' }]],
  bookmark: [['path', { d: 'M6.5 3.5h11v17l-5.5-4-5.5 4z' }]],
  note: [['path', { d: 'M5.5 3.5h9l4 4v13h-13z' }], ['path', { d: 'M14.5 3.5v4h4M8.5 12h7M8.5 15.5h5' }]],
  mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3.5 7l8.5 6 8.5-6' }]],
  back: [['path', { d: 'M19 12H5M11 18l-6-6 6-6' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  insert: [['path', { d: 'M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M5 20.5h14' }]],
  learn: [['path', { d: 'M2 9.5l10-5 10 5-10 5zM6 11.5v4.5c0 1.6 2.7 3 6 3s6-1.4 6-3v-4.5M22 9.5v5' }]],
  shield: [['path', { d: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z' }], ['path', { d: 'M8.8 12.2l2.2 2.2 4.2-4.4' }]],
  plug: [['path', { d: 'M9 2.5v5M15 2.5v5M6 7.5h12v3.5a6 6 0 0 1-12 0zM12 17v4.5' }]],
  server: [['rect', { x: 3.5, y: 4, width: 17, height: 7, rx: 2 }], ['rect', { x: 3.5, y: 13, width: 17, height: 7, rx: 2 }],
    ['path', { d: 'M7.5 7.5h.01M7.5 16.5h.01' }]],
  laptop: [['rect', { x: 4.5, y: 5, width: 15, height: 10.5, rx: 1.5 }], ['path', { d: 'M2.5 19h19' }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10' }]],
  eye: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.6 3.3M6.6 7.6C4 9.4 2.5 12 2.5 12S6 18 12 18c1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
  download: [['path', { d: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14' }]],
  upload: [['path', { d: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 20h14' }]],
  key: [['circle', { cx: 8, cy: 15, r: 4 }], ['path', { d: 'M10.8 12.2L20 3M16.5 6.5l3 3M14 9l2 2' }]],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 20.5c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5' }]],
  send: [['path', { d: 'M4 12l16-8-6 17-3-7z' }]],
  alert: [['path', { d: 'M12 3.5l9.5 16.5h-19z' }], ['path', { d: 'M12 10v4.5M12 17.5h.01' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5.5M12 7.5h.01' }]],
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ic' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, a] of ICONS[name] || []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);
