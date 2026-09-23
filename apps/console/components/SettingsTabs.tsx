'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t } from '@/lib/copy';

/**
 * Only the channel connections are offered here.
 *
 * Billing, Autopilot, Catalogue, Quick Replies, Security and History are
 * hidden rather than removed: their pages still exist and still answer at
 * their own URLs, so nothing is lost and any of them can be put back by
 * uncommenting one line. What went was the invitation to open them from a
 * workspace that does not use them.
 */
const TABS = [
  { href: '/pengaturan/email', label: t.settings.tabEmail },
  { href: '/pengaturan/instagram', label: t.settings.tabInstagram },
  { href: '/pengaturan/facebook', label: t.settings.tabFacebook },
  // { href: '/pengaturan', label: t.settings.tabBill },
  // { href: '/pengaturan/autopilot', label: t.autopilot.title },
  // { href: '/pengaturan/katalog', label: t.catalogue.title },
  // { href: '/pengaturan/balasan-cepat', label: t.quickReply.title },
  // { href: '/pengaturan/keamanan', label: t.security.title },
  // { href: '/pengaturan/riwayat', label: t.settings.tabHistory },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="tabs" role="navigation" aria-label={t.settings.title}>
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? 'page' : undefined}>
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
