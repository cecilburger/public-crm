'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Me } from '@/lib/api';

const ICONS = {
  chats: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />,
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
  { href: '/obrolan', label: t.nav.chats, icon: 'chats' as const, badge: true },
  { href: '/penjualan', label: t.nav.sales, icon: 'sales' as const, badge: false },
  { href: '/tim', label: t.nav.team, icon: 'team' as const, badge: false },
];

export function Rail({ me, needsReply }: { me: Me; needsReply: number }) {
  const pathname = usePathname();
  const router = useRouter();

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

      {NAV.map((n) => item(n.href, n.label, n.icon, n.badge && needsReply > 0 ? needsReply : undefined))}

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
