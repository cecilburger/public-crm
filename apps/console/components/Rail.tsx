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
  customers: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" /></>,
  orders: <><path d="M3 7l2-4h14l2 4M3 7h18M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7" /><path d="M9 11a3 3 0 0 0 6 0" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 12.5l2.3 2.3L16 9" /></>,
  contact: <><rect x="4" y="4" width="16" height="17" rx="2" /><circle cx="12" cy="10.5" r="2.3" /><path d="M8.3 16.5c.7-1.7 2-2.5 3.7-2.5s3 .8 3.7 2.5M9 4V2.5M15 4V2.5" /></>,
  brand: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></>,
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
} as const;

/**
 * Everything that isn't the inbox and isn't Penjualan's own drawer (split
 * around it below so it renders in its usual spot in the list): Dashboard
 * sits above this on its own, messaging lives in the Inbox drawer, and
 * Billing/history stay under Settings — none of that is in the way of the
 * person whose job is answering customers.
 */
const NAV_BEFORE_SALES = [
  { href: '/pelanggan', label: t.nav.customers, icon: 'customers' as const },
  { href: '/tugas', label: t.nav.tasks, icon: 'tasks' as const },
  { href: '/brand', label: t.nav.brand, icon: 'brand' as const },
];
const NAV_AFTER_SALES = [
  { href: '/tim', label: t.nav.team, icon: 'team' as const },
];

// Penjualan's own drawer — the sales board and the targets it's measured
// against read as one topic, so Target lives here instead of as a bare
// top-level item.
const PENJUALAN = [
  { href: '/penjualan', label: t.nav.sales },
  { href: '/target', label: t.nav.target },
];

// Every place a message can be read or answered, grouped under one drawer —
// Obrolan (every channel), Chat WA (the wa-bridge numbers specifically) and
// Channel WhatsApp (pairing/monitoring those same numbers) all read as "the
// inbox" even though they're three different pages.
const INBOX = [
  { href: '/obrolan', label: t.nav.chats, badge: true },
  { href: '/chat-wa', label: t.nav.chatWa, badge: false },
  { href: '/channel-wa', label: t.nav.channelWa, badge: false },
];

// A drawer of its own, same idea as Settings — reports an agent checks
// occasionally, not the three things they do every day.
const MONITORING = [
  { href: '/status-nomor', label: t.nav.waStatus },
  { href: '/performa-agen', label: t.nav.agentPerformance },
];

// Where a tenant shapes its own paperwork — starts with Dokumen (the PDF
// quotation/invoice template editor), more will land here later. The page
// itself doesn't exist yet; this just reserves its place in the menu.
const CUSTOMIZE = [
  { href: '/customize/dokumen', label: t.nav.document },
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

  const onInbox = INBOX.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [inboxExpanded, toggleInbox] = useExpandable(onInbox);

  const onMonitoring = MONITORING.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [monitoringExpanded, toggleMonitoring] = useExpandable(onMonitoring);

  const onCustomize = CUSTOMIZE.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [customizeExpanded, toggleCustomize] = useExpandable(onCustomize);

  const onPenjualan = PENJUALAN.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [penjualanExpanded, togglePenjualan] = useExpandable(onPenjualan);

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
        <button type="button" className="navitem navitem-toggle" onClick={() => openGroup(togglePenjualan)}
                aria-expanded={penjualanExpanded} aria-current={onPenjualan ? 'page' : undefined}
                title={collapsed ? t.nav.sales : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.sales}</svg>
          <span className="navitem-label">{t.nav.sales}</span>
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: penjualanExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {penjualanExpanded && !collapsed ? (
          <div className="rail-sub">
            {PENJUALAN.map((p) => {
              const active = pathname === p.href || pathname.startsWith(`${p.href}/`);
              return (
                <Link key={p.href} href={p.href} className="rail-sub-row" aria-current={active ? 'page' : undefined}>
                  <span className="rail-sub-label">{p.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      {NAV_AFTER_SALES.map((n) => item(n.href, n.label, n.icon))}

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
                  <span className="rail-sub-label">{c.label}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="railfoot">
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
