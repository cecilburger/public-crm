'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t } from '@/lib/copy';

const TABS = [
  { href: '/pengaturan', label: t.settings.tabBill },
  { href: '/pengaturan/autopilot', label: t.autopilot.title },
  { href: '/pengaturan/katalog', label: t.catalogue.title },
  { href: '/pengaturan/keamanan', label: t.security.title },
  { href: '/pengaturan/riwayat', label: t.settings.tabHistory },
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
