'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Me, WaBridgeChannel } from '@/lib/api';
import type { NotificationItem } from '@/lib/notifications';
import { WaBridgeRailList } from '@/components/WaBridgeRailList';
import { NotificationBell } from '@/components/NotificationBell';
import { GlobalSearch } from '@/components/GlobalSearch';

const ICONS = {
  dashboard: <><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /></>,
  inbox: <><path d="M4 4h16l2 8v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l2-8Z" /><path d="M2 12h6a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2h6" /></>,
  chats: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />,
  chatWa: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
  client: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" /></>,
  orders: <><path d="M3 7l2-4h14l2 4M3 7h18M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7" /><path d="M9 11a3 3 0 0 0 6 0" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 12.5l2.3 2.3L16 9" /></>,
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
 */
const NAV_BEFORE_SALES = [
  { href: '/client', label: t.nav.client, icon: 'client' as const },
  { href: '/tugas', label: t.nav.tasks, icon: 'tasks' as const },
  { href: '/brand', label: t.nav.brand, icon: 'brand' as const },
  { href: '/brand-management', label: t.nav.brandManagement, icon: 'brandManagement' as const },
];
const NAV_AFTER_SALES = [
  { href: '/tim', label: t.nav.team, icon: 'team' as const },
];

// Its own drawer, same idea as Customize — starts with just Workflow, more
// automation types will land here later.
const AUTOMATION = [
  { href: '/automation/workflow', label: t.automation.workflowTitle, icon: 'workflow' as const },
];

// Deal's own drawer — the deal board and the targets it's measured against
// read as one topic, so Target lives here instead of as a bare top-level item.
const DEAL = [
  { href: '/deal', label: t.nav.sales, icon: 'sales' as const },
  { href: '/target', label: t.nav.target, icon: 'target' as const },
];

// Its own top-level drawer, not under Pengaturan — the templates a broadcast
// sends are only useful in service of sending one, so Template Pesan moved
// here instead of staying a settings tab nobody without broadcast access needs.
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
  { href: '/channel-wa', label: t.nav.channelWa, badge: false, icon: 'channelWa' as const },
];

// A drawer of its own, same idea as Settings — reports an agent checks
// occasionally, not the three things they do every day.
const MONITORING = [
  { href: '/status-nomor', label: t.nav.waStatus, icon: 'waStatus' as const },
  { href: '/performa-agen', label: t.nav.agentPerformance, icon: 'agentPerformance' as const },
];

// Where a tenant shapes its own paperwork — starts with Dokumen (the PDF
// quotation/invoice template editor), more will land here later. The page
// itself doesn't exist yet; this just reserves its place in the menu.
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

  const onInbox = INBOX.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [inboxExpanded, toggleInbox] = useExpandable(onInbox);

  const onAutomation = AUTOMATION.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [automationExpanded, toggleAutomation] = useExpandable(onAutomation);

  const onMonitoring = MONITORING.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [monitoringExpanded, toggleMonitoring] = useExpandable(onMonitoring);

  const onCustomize = CUSTOMIZE.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [customizeExpanded, toggleCustomize] = useExpandable(onCustomize);

  const onDeal = DEAL.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [dealExpanded, toggleDeal] = useExpandable(onDeal);

  const onBroadcast = BROADCAST.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [broadcastExpanded, toggleBroadcast] = useExpandable(onBroadcast);

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

  const item = (href: string, label: string, icon: keyof typeof ICONS, badge?: number) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
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

      {NAV_BEFORE_SALES.map((n) => item(n.href, n.label, n.icon))}

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleBroadcast)}
                aria-expanded={broadcastExpanded} aria-current={onBroadcast ? 'page' : undefined}
                title={collapsed ? t.nav.broadcast : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.broadcast}</svg>
          <span className="navitem-label">{t.nav.broadcast}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: broadcastExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {broadcastExpanded && !collapsed ? (
          <div className="rail-sub">
            {BROADCAST.map((b) => {
              const active = pathname === b.href;
              return (
                <Link key={b.href} href={b.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">{ICONS[b.icon]}</svg>
                  <span className="rail-sub-label">{b.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleDeal)}
                aria-expanded={dealExpanded} aria-current={onDeal ? 'page' : undefined}
                title={collapsed ? t.nav.sales : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.sales}</svg>
          <span className="navitem-label">{t.nav.sales}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: dealExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {dealExpanded && !collapsed ? (
          <div className="rail-sub">
            {DEAL.map((p) => {
              const active = pathname === p.href || pathname.startsWith(`${p.href}/`);
              return (
                <Link key={p.href} href={p.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">{ICONS[p.icon]}</svg>
                  <span className="rail-sub-label">{p.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      {NAV_AFTER_SALES.map((n) => item(n.href, n.label, n.icon))}

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleAutomation)}
                aria-expanded={automationExpanded} aria-current={onAutomation ? 'page' : undefined}
                title={collapsed ? t.nav.automation : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.automation}</svg>
          <span className="navitem-label">{t.nav.automation}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: automationExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {automationExpanded && !collapsed ? (
          <div className="rail-sub">
            {AUTOMATION.map((a) => {
              const active = pathname === a.href || pathname.startsWith(`${a.href}/`);
              return (
                <Link key={a.href} href={a.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">{ICONS[a.icon]}</svg>
                  <span className="rail-sub-label">{a.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleMonitoring)}
                aria-expanded={monitoringExpanded} aria-current={onMonitoring ? 'page' : undefined}
                title={collapsed ? t.nav.monitoring : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.monitoring}</svg>
          <span className="navitem-label">{t.nav.monitoring}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: monitoringExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {monitoringExpanded && !collapsed ? (
          <div className="rail-sub">
            {MONITORING.map((m) => {
              const active = pathname === m.href || pathname.startsWith(`${m.href}/`);
              return (
                <Link key={m.href} href={m.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">{ICONS[m.icon]}</svg>
                  <span className="rail-sub-label">{m.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(toggleCustomize)}
                aria-expanded={customizeExpanded} aria-current={onCustomize ? 'page' : undefined}
                title={collapsed ? t.nav.customize : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.customize}</svg>
          <span className="navitem-label">{t.nav.customize}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: customizeExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {customizeExpanded && !collapsed ? (
          <div className="rail-sub">
            {CUSTOMIZE.map((c) => {
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

      <div className="railfoot">
        <button type="button" className="navitem navitem-toggle" onClick={cycleTheme}
                title={collapsed ? THEME_LABEL[theme] : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS[THEME_ICON[theme]]}</svg>
          <span className="navitem-label">{THEME_LABEL[theme]}</span>
        </button>
        {item('/pengaturan', t.nav.settings, 'settings')}
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
