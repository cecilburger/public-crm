/**
 * One small coloured icon per touchpoint type — shared between a task's own
 * Jenis and the quick-action row on a deal card, so "Meeting" always draws
 * the same calendar glyph everywhere it shows up.
 */
export const KIND_ICON_PATHS: Record<string, React.ReactNode> = {
  meeting: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>,
  call: <path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.5 21 3 13.5 3 4c0-.6.4-1 1-1h3.2c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8Z" />,
  online_meet: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10.5l5-3v9l-5-3" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />,
  email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  follow_up: <><path d="M4 21V4a1 1 0 0 1 1-1h12l-2.5 4.5L17 12H5" /></>,
};

const COLOR_CLASS: Record<string, string> = {
  meeting: 'meeting', call: 'call', online_meet: 'online_meet', chat: 'chat', email: 'email', follow_up: 'followup',
};

/** Renders nothing for a kind with no icon of its own ("Lainnya", a custom kind) — no icon reads better than a wrong one. */
export function KindIcon({ kind, title }: { kind: string; title?: string }) {
  const path = KIND_ICON_PATHS[kind];
  if (!path) return null;
  const colorCls = COLOR_CLASS[kind] ?? '';
  return (
    <span className={`kind-icon ${colorCls}`} title={title}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    </span>
  );
}
