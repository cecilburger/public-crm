import { getSession } from '@/lib/session';
import { t } from '@/lib/copy';

/**
 * "Divisi: Marketing" on the pages where a connection or a calendar is shown,
 * so nobody disconnects one division's account believing it was the other's.
 * Reads the same cookie every API call is made with, so it can never disagree
 * with the data on the page.
 */
export async function DivisionBadge() {
  const { division } = await getSession();
  return (
    <span className="chip" title={t.division.hint}>{t.division.badge(t.division[division])}</span>
  );
}
