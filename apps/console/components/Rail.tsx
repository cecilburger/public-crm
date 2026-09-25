'use client';

import Link from '@/components/FastLink';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Me, WaBridgeChannel } from '@/lib/api';
import type { NotificationItem } from '@/lib/notifications';
import { WaBridgeRailList } from '@/components/WaBridgeRailList';
import { NotificationBell } from '@/components/NotificationBell';
import { GlobalSearch } from '@/components/GlobalSearch';
import { DivisionSwitch } from '@/components/DivisionSwitch';

const ICONS = {
  dashboard: <><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /></>,
  inbox: <><path d="M4 4h16l2 8v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l2-8Z" /><path d="M2 12h6a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2h6" /></>,
  chats: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />,
  chatWa: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
  chatIg: <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17" cy="7" r="0.8" fill="currentColor" stroke="none" /></>,
  igComments: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></>,
  chatFb: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M13.5 20v-6.5h2.2l.4-2.7h-2.6v-1.7c0-.8.2-1.3 1.3-1.3h1.4V5.2c-.6-.1-1.4-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6v2h-2.3v2.7h2.3V20" /></>,
  fbComments: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /><path d="M12.8 15.2V11h1.5l.3-1.8h-1.8V8.1c0-.5.1-.9.8-.9h1V5.6a10 10 0 0 0-1.4-.1c-1.9 0-2.9 1.1-2.9 2.6V9.2H9v1.8h1.3v4.2" /></>,
  client: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" /></>,
  clientDeal: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5 5.5-5.5" /></>,
  clientProses: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></>,
  orders: <><path d="M3 7l2-4h14l2 4M3 7h18M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7" /><path d="M9 11a3 3 0 0 0 6 0" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 12.5l2.3 2.3L16 9" /></>,
  calendar: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>,
  contact: <><rect x="4" y="4" width="16" height="17" rx="2" /><circle cx="12" cy="10.5" r="2.3" /><path d="M8.3 16.5c.7-1.7 2-2.5 3.7-2.5s3 .8 3.7 2.5M9 4V2.5M15 4V2.5" /></>,
  brand: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></>,
  brandManagement: <><path d="M12 3v12M8 7l4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  waStatus: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  monitoring: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  customize: <>
    <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="18" x2="20" y2="18" /><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
  </>,
  chevron: <path d="M9 6l6 6-6 6" />,
  railToggle: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /><path d="M14 9l-2 3 2 3" /></>,
  signOut: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  sales: <><path d="M4 20V6m16 14V6M4 13h16" /><rect x="7" y="8" width="4" height="3" rx="1" /><rect x="13" y="15" width="4" height="3" rx="1" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>,
  team: <><circle cx="9" cy="9" r="3" /><path d="M3 19c0-3 2.7-4.6 6-4.6s6 1.6 6 4.6M16 6.5a3 3 0 0 1 0 5.6M18 19c0-2-.7-3.2-2-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  broadcast: <><path d="M4 11v2a2 2 0 0 0 2 2h1l1.5 5h2L9 15h2l7 4V5l-7 4H4a2 2 0 0 0-2 2Z" /><path d="M19 9a4 4 0 0 1 0 6" /><path d="M21.5 7a7.5 7.5 0 0 1 0 10" /></>,
  automation: <><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  themeSystem: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  themeLight: <><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" /></>,
  themeDark: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />,
  channelWa: <><path d="M12 20h.01" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M5 13a9 9 0 0 1 14 0" /></>,
  messageTemplate: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  agentPerformance: <path d="M4 19V13M10 19V9M16 19V5M4 19h16" />,
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>,
  workflow: <><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="6" r="2.3" /><circle cx="12" cy="18" r="2.3" /><path d="M8 7.7 11 16M16 7.7 13 16" /></>,
} as const;

type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'kirana-theme';
const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];

/**
 * Three states, not a binary switch — "ikuti sistem" stays available so
 * someone who's happy with their OS setting never has to pick a side. Starts
 * at 'system' on every render (matching the SSR guess) and only corrects
 * itself after mount, the same delayed-read shape as `useRailCollapsed`, so
 * hydration never has to reconcile a guess against real localStorage state.
 * The actual pixel flash on load is avoided separately, by a blocking inline
 * script in `layout.tsx` that sets the DOM attribute before first paint.
 */
function useTheme(): [ThemePref, () => void] {
  const [theme, setThemeState] = useState<ThemePref>('system');

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') setThemeState(stored);
  }, []);

  const cycle = () => {
    setThemeState((prev) => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length];
      if (next === 'system') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.removeItem(THEME_KEY);
      } else {
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem(THEME_KEY, next);
      }
      return next;
    });
  };

  return [theme, cycle];
}

/**
 * Everything that isn't the inbox and isn't Deal's own drawer (split
 * around it below so it renders in its usual spot in the list): Dashboard
 * sits above this on its own, messaging lives in the Inbox drawer, and
 * Billing/history stay under Settings — none of that is in the way of the
 * person whose job is answering customers.
 *
 * Kelola Brand (`/brand-management`) is hidden from here for now, not
 * deleted — the page and its import flow still work if visited directly.
 */
const NAV_BEFORE_SALES = [
  { href: '/calendar', label: t.nav.calendar, icon: 'calendar' as const },
  { href: '/brand', label: t.nav.brand, icon: 'brand' as const },
];
// Tugas (`/tugas`) is hidden from the rail for now, not deleted — the page
// still works if visited directly, and the Client pages' "Jadwal Meeting"
// action links straight into it.
const TASKS: { href: string; label: string; icon: keyof typeof ICONS }[] = [
  { href: '/tugas', label: t.nav.tasks, icon: 'tasks' as const },
];
// Tim (`/tim`) is hidden from here for now, not deleted — the page still
// works if visited directly.
const NAV_AFTER_SALES: { href: string; label: string; icon: keyof typeof ICONS }[] = [];

// Client Deal and Client On Proses are the same table, filtered two ways —
// one drawer, same idea as Deal/Broadcast, rather than two flat top-level items.
const CLIENT = [
  { href: '/client/proses', label: t.nav.clientProses, icon: 'clientProses' as const },
  { href: '/client/deal', label: t.nav.clientDeal, icon: 'clientDeal' as const },
];

// Hidden from the rail for now (not deleted — /automation/workflow still
// works if visited directly). Its own drawer, same idea as Customize —
// starts with just Workflow, more automation types will land here later.
const AUTOMATION = [
  { href: '/automation/workflow', label: t.automation.workflowTitle, icon: 'workflow' as const },
];

// Hidden from the rail for now (not deleted — /deal and /target still work
// if visited directly, and this list is what a restore re-adds a render
// block for). Deal's own drawer — the deal board and the targets it's
// measured against read as one topic, so Target lives here instead of as a
// bare top-level item.
const DEAL = [
  { href: '/deal', label: t.nav.sales, icon: 'sales' as const },
  { href: '/target', label: t.nav.target, icon: 'target' as const },
];

// Hidden from the rail for now (not deleted — /broadcast and
// /broadcast/template-pesan still work if visited directly). Its own
// top-level drawer, not under Pengaturan — the templates a broadcast sends
// are only useful in service of sending one, so Template Pesan moved here
// instead of staying a settings tab nobody without broadcast access needs.
const BROADCAST = [
  { href: '/broadcast', label: t.broadcast.title, icon: 'broadcast' as const },
  { href: '/broadcast/template-pesan', label: t.messageTemplate.title, icon: 'messageTemplate' as const },
];

// Every place a message can be read or answered, grouped under one drawer —
// Obrolan (every channel), Chat WA (the wa-bridge numbers specifically) and
// Channel WhatsApp (pairing/monitoring those same numbers) all read as "the
// inbox" even though they're three different pages.
const INBOX = [
  { href: '/obrolan', label: t.nav.chats, badge: true, icon: 'chats' as const },
  { href: '/chat-wa', label: t.nav.chatWa, badge: false, icon: 'chatWa' as const },
  { href: '/chat-ig', label: t.nav.chatIg, badge: false, icon: 'chatIg' as const },
  { href: '/komentar-ig', label: t.nav.igComments, badge: false, icon: 'igComments' as const },
  { href: '/chat-fb', label: t.nav.chatFb, badge: false, icon: 'chatFb' as const },
  { href: '/komentar-fb', label: t.nav.fbComments, badge: false, icon: 'fbComments' as const },
  { href: '/channel-wa', label: t.nav.channelWa, badge: false, icon: 'channelWa' as const },
];

// Hidden from the rail for now (not deleted — /status-nomor and
// /performa-agen still work if visited directly). A drawer of its own, same
// idea as Settings — reports an agent checks occasionally, not the three
// things they do every day.
const MONITORING = [
  { href: '/status-nomor', label: t.nav.waStatus, icon: 'waStatus' as const },
  { href: '/performa-agen', label: t.nav.agentPerformance, icon: 'agentPerformance' as const },
];

// Hidden from the rail for now (not deleted — /customize/dokumen still
// works if visited directly). Where a tenant shapes its own paperwork —
// starts with Dokumen (the PDF quotation/invoice template editor), more
// will land here later.
const CUSTOMIZE = [
  { href: '/customize/dokumen', label: t.nav.document, icon: 'document' as const },
];

/**
 * Opens by itself the moment you land on one of its pages, but after that
 * the toggle button has full control — including collapsing it while a page
 * inside it is still the active one. Landing on a *different* page in the
 * same group later (`active` flips false→true again) re-opens it fresh.
 */
function useExpandable(active: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return [open, () => setOpen((v) => !v)];
}

const RAIL_COLLAPSED_KEY = 'rail-collapsed';

/**
 * Icon-only mode, remembered across visits via localStorage. The width itself
 * lives in `--rail` (see globals.css) so this only has to flip one class on
 * <html> — same reasoning as the notif panel: the rail's own `overflow-y:auto`
 * would clip anything that tried to grow past its box instead.
 */
function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('rail-collapsed', collapsed);
  }, [collapsed]);

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  return [collapsed, toggle];
}

export function Rail({
  me, needsReply, notifications, waChannels,
}: { me: Me; needsReply: number; notifications: NotificationItem[]; waChannels: WaBridgeChannel[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const onChatWa = pathname === '/chat-wa' || pathname.startsWith('/chat-wa/');

  const [collapsed, toggleCollapsed] = useRailCollapsed();
  const [theme, cycleTheme] = useTheme();
  const THEME_LABEL: Record<ThemePref, string> = {
    system: t.nav.themeSystem, light: t.nav.themeLight, dark: t.nav.themeDark,
  };
  const THEME_ICON: Record<ThemePref, keyof typeof ICONS> = {
    system: 'themeSystem', light: 'themeLight', dark: 'themeDark',
  };

  const onClient = CLIENT.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    || pathname === '/client' || pathname.startsWith('/client/');
  const [clientExpanded, toggleClient] = useExpandable(onClient);

  const onInbox = INBOX.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [inboxExpanded, toggleInbox] = useExpandable(onInbox);

  // A group toggle only opens a flyout while collapsed there's nowhere to put
  // it, so the click both expands the rail and opens the group instead.
  const openGroup = (toggle: () => void) => {
    if (collapsed) toggleCollapsed();
    toggle();
  };

  const signOut = async () => {
    await fetch('/api/session', { method: 'DELETE' });
    router.replace('/masuk');
  };

  // `matchPrefix` exists for a link whose destination is not the root of the
  // section it represents: Settings opens on the first tab that is actually
  // shown, but must still light up on every other tab under /pengaturan.
  const item = (
    href: string, label: string, icon: keyof typeof ICONS, badge?: number, matchPrefix?: string,
  ) => {
    const base = matchPrefix ?? href;
    const active = pathname === base || pathname.startsWith(`${base}/`);
    return (
      <Link key={href} href={href} className="navitem" aria-current={active ? 'page' : undefined}
            title={collapsed ? label : undefined}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
             strokeLinecap="round" strokeLinejoin="round">{ICONS[icon]}</svg>
        <span className="navitem-label">{label}</span>
        {badge ? <span className="count tnum">{badge}</span> : null}
      </Link>
    );
  };

  return (
    <nav className={`rail${collapsed ? ' collapsed' : ''}`} aria-label="Menu utama">
      <div className="brand">
        <img src="/logo.webp" alt="" className="mark" />
        <span className="brand-name">{t.app.name}</span>
        <span className="brand-notif"><NotificationBell items={notifications} /></span>
      </div>

      <DivisionSwitch active={me.division} divisions={me.divisions} collapsed={collapsed} />

      <button type="button" className="navitem navitem-toggle rail-toggle" onClick={toggleCollapsed}
              aria-pressed={collapsed} title={collapsed ? t.nav.expand : undefined}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
             strokeLinecap="round" strokeLinejoin="round">{ICONS.railToggle}</svg>
        <span className="navitem-label">{collapsed ? t.nav.expand : t.nav.collapse}</span>
      </button>

      <GlobalSearch />

      {item('/dashboard', t.nav.dashboard, 'dashboard')}

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleInbox)}
                aria-expanded={inboxExpanded} aria-current={onInbox ? 'page' : undefined}
                title={collapsed ? t.nav.inbox : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.inbox}</svg>
          <span className="navitem-label">{t.nav.inbox}</span>
          {needsReply > 0 ? <span className="count tnum">{needsReply}</span> : null}
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: inboxExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {inboxExpanded && !collapsed ? (
          <div className="rail-sub">
            {INBOX.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              const badgeCount = n.badge && needsReply > 0 ? needsReply : undefined;
              return (
                <div key={n.href}>
                  <Link href={n.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                         strokeLinecap="round" strokeLinejoin="round">{ICONS[n.icon]}</svg>
                    <span className="rail-sub-label">{n.label}</span>
                    {badgeCount ? <span className="count tnum">{badgeCount}</span> : null}
                  </Link>
                  {n.href === '/chat-wa' && onChatWa ? <WaBridgeRailList channels={waChannels} /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleClient)}
                aria-expanded={clientExpanded} aria-current={onClient ? 'page' : undefined}
                title={collapsed ? t.nav.client : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.client}</svg>
          <span className="navitem-label">{t.nav.client}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: clientExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {clientExpanded && !collapsed ? (
          <div className="rail-sub">
            {CLIENT.map((c) => {
              const active = pathname === c.href || pathname.startsWith(`${c.href}/`);
              return (
                <Link key={c.href} href={c.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">{ICONS[c.icon]}</svg>
                  <span className="rail-sub-label">{c.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      {NAV_BEFORE_SALES.map((n) => item(n.href, n.label, n.icon))}

      {NAV_AFTER_SALES.map((n) => item(n.href, n.label, n.icon))}

      <div className="railfoot">
        <button type="button" className="navitem navitem-toggle" onClick={cycleTheme}
                title={collapsed ? THEME_LABEL[theme] : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS[THEME_ICON[theme]]}</svg>
          <span className="navitem-label">{THEME_LABEL[theme]}</span>
        </button>
        {item('/pengaturan/email', t.nav.settings, 'settings', undefined, '/pengaturan')}
        <div className="whoami" title={collapsed ? me.user.name : undefined}>
          <span className="avatar" aria-hidden>{initials(me.user.name)}</span>
          <span className="whoami-info" style={{ minWidth: 0 }}>
            <span className="name" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me.user.name}
            </span>
            <span className="role">{t.roles[me.user.role] ?? me.user.role}</span>
          </span>
        </div>
        <button type="button" className="navitem navitem-toggle" onClick={signOut}
                title={collapsed ? t.nav.signOut : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.signOut}</svg>
          <span className="navitem-label">{t.nav.signOut}</span>
        </button>
      </div>
    </nav>
  );
}
