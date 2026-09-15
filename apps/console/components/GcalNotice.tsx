'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { t } from '@/lib/copy';

/**
 * The success/error banner is driven by a `?gcal=` query param set by the
 * OAuth callback redirect. Left alone, that param stays in the URL and the
 * banner keeps reappearing on every later page load/revalidation (e.g. after
 * marking a task done) — so this strips it from the URL right after first
 * paint, and also offers a manual close.
 */
export function GcalNotice({ variant, detail }: { variant: 'connected' | 'error'; detail?: string }) {
  const [visible, setVisible] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    router.replace(pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  const good = variant === 'connected';
  return (
    <div className="notice" style={{ background: good ? 'var(--good-soft)' : 'var(--danger-soft)', borderColor: good ? 'var(--good)' : 'var(--danger)' }}>
      <span className="notice-icon" style={{ background: good ? 'var(--good)' : 'var(--danger)' }}>{good ? '✓' : '!'}</span>
      <span>{good ? t.tasks.googleConnectedNotice : `${t.tasks.googleConnectFailed}${detail ? ` (${detail})` : ''}`}</span>
      <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setVisible(false)} aria-label={t.tasks.closeNotice}>
        ×
      </button>
    </div>
  );
}
