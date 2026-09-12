'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Contact, ContactPurchaseSummary } from '@/lib/api';
import { ago, initials, rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { CustomerRowActions } from '@/components/CustomerRowActions';

type Group = { label: string | null; rows: Contact[] };

// The Filters and Group By controls are independent <details> dropdowns, each
// absolutely positioned relative to its own <summary>. Nothing stops both from
// being open at once, and when they are, their panels land close enough to
// overlap into a garbled mess of checkboxes and radios. This keeps at most one
// open — expanding either one closes the other and closing on an outside click
// so a panel doesn't linger over content the user has moved on from.
function useSingleOpenDropdown() {
  const filterRef = useRef<HTMLDetailsElement>(null);
  const groupRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      for (const ref of [filterRef, groupRef]) {
        if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const closeOthers = (opened: 'filter' | 'group') => {
    if (opened === 'filter' && groupRef.current) groupRef.current.open = false;
    if (opened === 'group' && filterRef.current) filterRef.current.open = false;
  };

  return { filterRef, groupRef, closeOthers };
}

export function CustomerTable({
  contacts, conversationByContact = {}, purchasesByContact = {},
}: {
  contacts: Contact[]; conversationByContact?: Record<string, string>;
  purchasesByContact?: Record<string, ContactPurchaseSummary>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<'none' | 'tag'>('none');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('list');
  const { filterRef, groupRef, closeOthers } = useSingleOpenDropdown();

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) for (const tag of c.tags) if (tag !== 'customer') set.add(tag);
    return [...set].sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (activeTags.length > 0 && !c.tags.some((tag) => activeTags.includes(tag))) return false;
      if (!q) return true;
      const haystack = [c.displayName, c.phone, ...c.tags].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [contacts, query, activeTags]);

  const groups = useMemo<Group[]>(() => {
    if (groupBy !== 'tag') return [{ label: null, rows: filtered }];

    const byTag = new Map<string, Contact[]>();
    const untagged: Contact[] = [];
    for (const c of filtered) {
      const labels = c.tags.filter((tag) => tag !== 'customer');
      if (labels.length === 0) { untagged.push(c); continue; }
      for (const tag of labels) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(c);
      }
    }
    const out = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([label, rows]): Group => ({ label, rows }));
    if (untagged.length > 0) out.push({ label: t.customers.noLabel, rows: untagged });
    return out;
  }, [filtered, groupBy]);

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]));

  // The kanban card is itself a <Link> to the customer record, so the Chat
  // button can't be a nested <a> — it navigates through the router instead,
  // stopping the click before it bubbles up to the card's own link.
  const goToChat = (conversationId: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/obrolan/${conversationId}`);
  };

  const renderKanbanCard = (c: Contact) => {
    const conversationId = conversationByContact[c.id];
    return (
      <Link href={`/pelanggan/${c.id}`} key={c.id} className="kanban-card">
        <div className="kanban-card-top">
          <span className="kanban-avatar" aria-hidden>{initials(c.displayName)}</span>
          <div className="kanban-details">
            <b className="kanban-title">{c.displayName ?? c.phone ?? '—'}</b>
            <div className="kanban-subtitle mono">{c.phone ?? '—'}</div>
            {c.tags.length > 0 && (
              <div className="kanban-tags">
                {c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
              </div>
            )}
          </div>
        </div>
        <div className="kanban-card-bottom">
          <span className="dim" style={{ fontSize: 11 }}>{ago(c.lastSeenAt)}</span>
          {purchasesByContact[c.id] ? (
            <span className="dim tnum" style={{ fontSize: 11, marginLeft: 8 }}>
              {purchasesByContact[c.id].count}x · {rp(purchasesByContact[c.id].totalIdr)}
            </span>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn ghost sm" disabled={!conversationId}
                  title={conversationId ? undefined : t.customers.noChat}
                  onClick={conversationId ? goToChat(conversationId) : undefined}>
            {t.customers.chat}
          </button>
        </div>
      </Link>
    );
  };

  const row = (c: Contact) => {
    const conversationId = conversationByContact[c.id];
    return (
      <tr key={c.id}>
        <td style={{ textAlign: 'center' }}>
          <input type="checkbox" style={{ accentColor: 'var(--brand)', cursor: 'pointer' }} />
        </td>
        <td>
          <Link href={`/pelanggan/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span className="avatar" aria-hidden>{initials(c.displayName)}</span>
            <b>{c.displayName ?? c.phone ?? '—'}</b>
          </Link>
        </td>
        <td className="mono">{c.phone ?? '—'}</td>
        <td>
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
          </span>
        </td>
        <td className="num">{purchasesByContact[c.id]?.count ?? 0}</td>
        <td className="num">{rp(purchasesByContact[c.id]?.totalIdr ?? 0)}</td>
        <td className="num">{ago(c.lastSeenAt)}</td>
        <td style={{ textAlign: 'center' }}>
          {conversationId ? (
            <Link href={`/obrolan/${conversationId}`} className="btn ghost sm">{t.customers.chat}</Link>
          ) : (
            <button type="button" className="btn ghost sm" disabled title={t.customers.noChat}>
              {t.customers.chat}
            </button>
          )}
        </td>
        <td style={{ textAlign: 'center' }}><CustomerRowActions id={c.id} name={c.displayName ?? c.phone ?? '—'} /></td>
      </tr>
    );
  };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.customers.title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.customers.searchPlaceholder} aria-label={t.customers.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <Link href="/pelanggan/baru" className="btn primary">{t.customers.add}</Link>
          </div>
          <div className="odoo-cp-right">
            <span className="dim tnum" style={{ fontSize: 12.5, marginRight: 8 }}>
              {filtered.length} {t.customers.title.toLowerCase()}
            </span>

            <details className="dropdown" ref={filterRef} onToggle={(e) => e.currentTarget.open && closeOthers('filter')}>
              <summary className="btn ghost sm">
                {t.customers.filters}{activeTags.length > 0 ? ` (${activeTags.length})` : ''}
              </summary>
              <div className="dropdown-body vertical">
                {availableTags.length === 0 ? (
                  <p className="dim" style={{ fontSize: 12.5, padding: '4px 6px' }}>{t.customers.noFilters}</p>
                ) : availableTags.map((tag) => (
                  <label key={tag} className="dropdown-check">
                    <input type="checkbox" checked={activeTags.includes(tag)} onChange={() => toggleTag(tag)} />
                    {tag}
                  </label>
                ))}
              </div>
            </details>

            <details className="dropdown" ref={groupRef} onToggle={(e) => e.currentTarget.open && closeOthers('group')}>
              <summary className="btn ghost sm">
                {t.customers.groupBy}{groupBy !== 'none' ? ' •' : ''}
              </summary>
              <div className="dropdown-body vertical">
                <label className="dropdown-check">
                  <input type="radio" name="pelanggan-groupby" checked={groupBy === 'none'}
                         onChange={() => setGroupBy('none')} />
                  {t.customers.noGroup}
                </label>
                <label className="dropdown-check">
                  <input type="radio" name="pelanggan-groupby" checked={groupBy === 'tag'}
                         onChange={() => setGroupBy('tag')} />
                  {t.customers.groupByTag}
                </label>
              </div>
            </details>

            <div className="odoo-view-switchers">
              <button className={`btn icon ${viewMode === 'kanban' ? 'active' : 'ghost'}`} 
                      onClick={() => setViewMode('kanban')} aria-label="Kanban">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>
                </svg>
              </button>
              <button className={`btn icon ${viewMode === 'list' ? 'active' : 'ghost'}`} 
                      onClick={() => setViewMode('list')} aria-label="List">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {contacts.length === 0 ? t.customers.noCustomers : t.customers.noMatches}
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label ?? '__all__'} style={{ marginTop: 14 }}>
              {g.label ? <div className="group-header" style={{ marginBottom: viewMode === 'kanban' ? 14 : 0, borderRadius: viewMode === 'kanban' ? 8 : undefined }}>{g.label} <span className="dim">({g.rows.length})</span></div> : null}
              
              {viewMode === 'kanban' ? (
                <div className="kanban-grid">
                  {g.rows.map(renderKanbanCard)}
                </div>
              ) : (
                <div className="panel" style={{ borderTopLeftRadius: g.label ? 0 : undefined, borderTopRightRadius: g.label ? 0 : undefined, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <table className="odoo-table">
                    <thead>
                      <tr>
                        <th style={{ width: 44 }} aria-label="checkbox"></th>
                        <th>{t.customers.name}</th>
                        <th>{t.customers.phone}</th>
                        <th>{t.customers.tags}</th>
                        <th className="num">{t.customers.purchases.count}</th>
                        <th>{t.customers.purchases.column}</th>
                        <th className="num">{t.customers.lastSeen}</th>
                        <th style={{ textAlign: 'center' }}>{t.customers.chat}</th>
                        <th style={{ textAlign: 'center' }}>{t.customers.actions}</th>
                      </tr>
                    </thead>
                    <tbody>{g.rows.map(row)}</tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
