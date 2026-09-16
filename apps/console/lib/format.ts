const idr = new Intl.NumberFormat('id-ID');

export const rp = (n: number | string): string => `Rp ${idr.format(Math.round(Number(n)))}`;
export const num = (n: number | string): string => idr.format(Math.round(Number(n)));

/** Inbox timestamps: relative while it matters, absolute once it does not. */
export function ago(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86_400) return `${Math.floor(secs / 86_400)}d`;
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/** Time alone for today, date and time once it is older — a bare "15.29" on a
 *  two-day-old message reads as if it just arrived. */
export function clock(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${time}`;
}

/** A span of time, not a point — "6 menit" / "2 jam 15 menit". */
export function duration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin} menit`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours} jam` : `${hours} jam ${mins} menit`;
}

/** A plain calendar date, no time — target periods, deal close dates. */
export function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** ISO timestamp → the value a `datetime-local` input needs to show it in the
 *  browser's own local time, for pre-filling an edit form. */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "Hari ini" / "Besok" / "3 hari lagi" / "Terlambat 2 hari" — the same
 * relative-countdown language a kanban due date reads in, so a target close
 * date carries as much at-a-glance urgency on a deal card as it would for a task.
 * Accepts either a plain "YYYY-MM-DD" or a full ISO timestamp — only the date
 * part is ever used, parsed at local midnight so it never shifts a day off.
 */
export function dueLabel(dateOnlyIso: string | null): string | null {
  if (!dateOnlyIso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateOnlyIso.slice(0, 10)}T00:00:00`);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'Hari ini';
  if (days === 1) return 'Besok';
  if (days === -1) return 'Kemarin';
  if (days > 1) return `${days} hari lagi`;
  return `Terlambat ${Math.abs(days)} hari`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp', whatsapp_web: 'WhatsApp Web', instagram: 'Instagram', messenger: 'Messenger',
  tiktok: 'TikTok', telegram: 'Telegram', tokopedia: 'Tokopedia', shopee: 'Shopee', email: 'Email', webchat: 'Web',
};

/**
 * The queue an agent actually works: the customer spoke last and nobody has
 * answered. Not the same as "open" — a thread can be open with our reply
 * sitting at the bottom of it.
 */
export function awaitingReply(c: {
  status: string;
  last_inbound_at: string | null;
  last_message_at: string | null;
}): boolean {
  return c.status !== 'resolved' && c.last_inbound_at !== null && c.last_message_at === c.last_inbound_at;
}
