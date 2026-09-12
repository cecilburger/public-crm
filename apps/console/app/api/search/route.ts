import { NextRequest, NextResponse } from 'next/server';
import { api, type Contact, type Order, type Task, type Brand, type Deal } from '@/lib/api';
import { rp } from '@/lib/format';

export interface SearchResult {
  id: string;
  category: 'contact' | 'order' | 'task' | 'brand' | 'deal';
  title: string;
  subtitle: string | null;
  href: string;
}

const LIMIT_PER_CATEGORY = 5;

const norm = (v: unknown) => String(v ?? '').toLowerCase();
const haystack = (...parts: unknown[]) => parts.filter(Boolean).join(' ').toLowerCase();

/**
 * One box, every entity — reuses the exact same list endpoints each page
 * already calls, filtered here instead of a new indexed search on the
 * backend. Fine at this data scale (the same reasoning every list page's
 * own client-side search already relies on); worth an indexed query later
 * if a tenant's data outgrows fetching it whole.
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ results: [] as SearchResult[] });
  const needle = norm(q);

  const [contacts, orders, tasks, brands, deals] = await Promise.all([
    api<Contact[]>('/v1/contacts').catch(() => [] as Contact[]),
    api<Order[]>('/v1/orders').catch(() => [] as Order[]),
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
  ]);

  const results: SearchResult[] = [];

  for (const c of contacts) {
    if (!haystack(c.displayName, c.phone).includes(needle)) continue;
    results.push({
      id: c.id, category: 'contact', title: c.displayName ?? c.phone ?? '—',
      subtitle: c.displayName && c.phone ? c.phone : null, href: `/pelanggan/${c.id}`,
    });
    if (results.filter((r) => r.category === 'contact').length >= LIMIT_PER_CATEGORY) break;
  }

  for (const o of orders) {
    if (!haystack(o.code, o.displayName, o.phone).includes(needle)) continue;
    results.push({
      id: o.id, category: 'order', title: o.code,
      subtitle: `${o.displayName ?? o.phone ?? '—'} · ${rp(o.totalIdr)}`, href: '/pesanan',
    });
    if (results.filter((r) => r.category === 'order').length >= LIMIT_PER_CATEGORY) break;
  }

  for (const tk of tasks) {
    if (!haystack(tk.title, tk.contactName, tk.contactPhone, tk.dealTitle).includes(needle)) continue;
    results.push({
      id: tk.id, category: 'task', title: tk.title,
      subtitle: tk.contactName ?? tk.contactPhone, href: '/tugas',
    });
    if (results.filter((r) => r.category === 'task').length >= LIMIT_PER_CATEGORY) break;
  }

  for (const b of brands) {
    if (!haystack(b.name, b.picName, b.phone, b.email, b.instagram, b.city, b.category).includes(needle)) continue;
    results.push({
      id: b.id, category: 'brand', title: b.name,
      subtitle: b.picName ?? b.city ?? b.category, href: `/brand/${b.id}`,
    });
    if (results.filter((r) => r.category === 'brand').length >= LIMIT_PER_CATEGORY) break;
  }

  for (const d of deals) {
    if (!haystack(d.title, d.contact_name).includes(needle)) continue;
    results.push({
      id: d.id, category: 'deal', title: d.title,
      subtitle: d.contact_name, href: `/penjualan/${d.id}`,
    });
    if (results.filter((r) => r.category === 'deal').length >= LIMIT_PER_CATEGORY) break;
  }

  return NextResponse.json({ results });
}
