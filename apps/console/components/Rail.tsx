'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Me, WaBridgeChannel } from '@/lib/api';
import { WaBridgeRailList } from '@/components/WaBridgeRailList';

const ICONS = {
  dashboard: <><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /></>,
  chats: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />,
  chatWa: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
  customers: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" /></>,
  orders: <><path d="M3 7l2-4h14l2 4M3 7h18M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7" /><path d="M9 11a3 3 0 0 0 6 0" /></>,
  contact: <><rect x="4" y="4" width="16" height="17" rx="2" /><circle cx="12" cy="10.5" r="2.3" /><path d="M8.3 16.5c.7-1.7 2-2.5 3.7-2.5s3 .8 3.7 2.5M9 4V2.5M15 4V2.5" /></>,
  waStatus: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  monitoring: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  sales: <><path d="M4 20V6m16 14V6M4 13h16" /><rect x="7" y="8" width="4" height="3" rx="1" /><rect x="13" y="15" width="4" height="3" rx="1" /></>,
  team: <><circle cx="9" cy="9" r="3" /><path d="M3 19c0-3 2.7-4.6 6-4.6s6 1.6 6 4.6M16 6.5a3 3 0 0 1 0 5.6M18 19c0-2-.7-3.2-2-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
} as const;

/**
 * Three things an agent does every day, and one drawer for everything else.
 * Billing and history are still complete — they are just not in the way of the
 * person whose job is answering customers.
 */
const NAV = [
  { href: '/dashboard', label: t.nav.dashboard, icon: 'dashboard' as const, badge: false },
  { href: '/obrolan', label: t.nav.chats, icon: 'chats' as const, badge: true },
  { href: '/chat-wa', label: t.nav.chatWa, icon: 'chatWa' as const, badge: false },
  { href: '/pelanggan', label: t.nav.customers, icon: 'customers' as const, badge: false },
  { href: '/pesanan', label: t.nav.orders, icon: 'orders' as const, badge: false },
  { href: '/kontak', label: t.nav.contact, icon: 'contact' as const, badge: false },
  { href: '/penjualan', label: t.nav.sales, icon: 'sales' as const, badge: false },
  { href: '/tim', label: t.nav.team, icon: 'team' as const, badge: false },
];

// A drawer of its own, same idea as Settings — reports an agent checks
// occasionally, not the three things they do every day. Just one page in it
// for now, but the group is the point: more monitoring views land here later
// instead of crowding the main list.
const MONITORING = [
  { href: '/status-nomor', label: t.nav.waStatus },
  { href: '/performa-agen', label: t.nav.agentPerformance },
];

export function Rail({ me, needsReply, waChannels }: { me: Me; needsReply: number; waChannels: WaBridgeChannel[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const onChatWa = pathname === '/chat-wa' || pathname.startsWith('/chat-wa/');

  // Opens by itself while you're on one of its pages, closes on click
  // otherwise — so it never hides the page you're actually looking at.
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  const onMonitoring = MONITORING.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const monitoringExpanded = monitoringOpen || onMonitoring;

  const signOut = async () => {
    await fetch('/api/session', { method: 'DELETE' });
    router.replace('/masuk');
  };

  const item = (href: string, label: string, icon: keyof typeof ICONS, badge?: number) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link key={href} href={href} className="navitem" aria-current={active ? 'page' : undefined}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
             strokeLinecap="round" strokeLinejoin="round">{ICONS[icon]}</svg>
        {label}
        {badge ? <span className="count tnum">{badge}</span> : null}
      </Link>
    );
  };

  return (
    <nav className="rail" aria-label="Menu utama">
      <div className="brand"><span className="mark"><i /></span>{t.app.name}</div>

      {NAV.map((n) => (
        <div key={n.href}>
          {item(n.href, n.label, n.icon, n.badge && needsReply > 0 ? needsReply : undefined)}
          {n.href === '/chat-wa' && onChatWa ? <WaBridgeRailList channels={waChannels} /> : null}
        </div>
      ))}

      <div>
        <button type="button" className="navitem navitem-toggle" onClick={() => setMonitoringOpen((v) => !v)}
                aria-expanded={monitoringExpanded} aria-current={onMonitoring ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">{ICONS.monitoring}</svg>
          {t.nav.monitoring}
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round" style={{ transform: monitoringExpanded ? 'rotate(90deg)' : undefined }}>
            {ICONS.chevron}
          </svg>
        </button>
        {monitoringExpanded ? (
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

      <div className="railfoot">
        {item('/pengaturan', t.nav.settings, 'settings')}
        <div className="whoami">
          <span className="avatar" aria-hidden>{initials(me.user.name)}</span>
          <span style={{ minWidth: 0 }}>
            <span className="name" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me.user.name}
            </span>
            <span className="role">{t.roles[me.user.role] ?? me.user.role}</span>
          </span>
        </div>
        <button className="btn ghost sm" onClick={signOut} style={{ width: '100%', justifyContent: 'flex-start' }}>
          {t.nav.signOut}
        </button>
      </div>
    </nav>
  );
}
