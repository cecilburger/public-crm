'use client';

import { usePathname } from 'next/navigation';
import { t } from '@/lib/copy';
import type { Division } from '@/lib/api';
import { CsrfField } from '@/components/Csrf';

/**
 * [ Marketing | AI ] in the sidebar.
 *
 * A real form post to `/api/division`, not a client-side state change: the
 * division is decided by an httpOnly cookie the API reads on every request,
 * and the 303 that follows is a full navigation, so every page — inbox,
 * clients, calendar, settings — re-renders for the new division at once and
 * the router cache can never show the old one. Works without JavaScript for
 * the same reason every other mutation here does.
 */
export function DivisionSwitch({
  active, divisions, collapsed,
}: { active: Division; divisions: Division[]; collapsed: boolean }) {
  const pathname = usePathname();

  if (collapsed) {
    return (
      <div className="division-switch collapsed" title={`${t.division.label}: ${active.name}`}>
        <span className="chip" aria-label={t.division.badge(active.name)}>{active.name.slice(0, 1)}</span>
      </div>
    );
  }

  return (
    <form method="post" action="/api/division" className="division-switch" aria-label={t.division.switch}>
      <CsrfField />
      <input type="hidden" name="returnTo" value={pathname} />
      <span className="dim division-label">{t.division.label}</span>
      <span className="division-options">
        {divisions.map((d) => {
          const isActive = d.id === active.id;
          return (
            <button key={d.id} type="submit" name="division" value={d.key}
                    className={`btn sm ${isActive ? 'primary' : 'ghost'}`}
                    aria-pressed={isActive} disabled={isActive} title={t.division.hint}>
              {d.name}
            </button>
          );
        })}
      </span>
    </form>
  );
}
