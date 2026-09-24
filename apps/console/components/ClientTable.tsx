'use client';

import Link from '@/components/FastLink';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Contact, Task } from '@/lib/api';
import { ago, initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { ClientRowActions } from '@/components/ClientRowActions';
import { ClientQuickAddTaskDrawer } from '@/components/ClientQuickAddTaskDrawer';
import { ClientMeetingDetailDrawer } from '@/components/ClientMeetingDetailDrawer';
import { ClientAddDrawer } from '@/components/ClientAddDrawer';
import { ClientDetailDrawer } from '@/components/ClientDetailDrawer';
import { useCsrfToken } from '@/components/Csrf';
import { updateClient } from '@/app/(app)/actions';

type Group = { label: string | null; rows: Contact[] };

const STORE_STATUS_CHIP: Record<string, string> = { aktif: 'chip good', prospek: 'chip warn', nonaktif: 'chip' };

function formatMeeting(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
}

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

export function ClientTable({
  contacts, conversationByContact = {}, meetingByContact = {},
  title = t.client.title, emptyMessage = t.client.noClients,
}: {
  contacts: Contact[]; conversationByContact?: Record<string, string>;
  meetingByContact?: Record<string, Task>;
  title?: string; emptyMessage?: string;
}) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<'none' | 'tag'>('none');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('list');
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [presetContact, setPresetContact] = useState<{ id: string; name: string } | null>(null);
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [savingStatusId, setSavingStatusId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const { filterRef, groupRef, closeOthers } = useSingleOpenDropdown();

  // A contact with an open meeting already on the books gets that meeting's
  // own detail/edit view instead of another create form — the "Meeting"
  // action either books the first one or manages the one that exists, never
  // both at once.
  const openScheduleMeeting = (contact: { id: string; name: string }) => {
    const existing = meetingByContact[contact.id];
    if (existing) { setDetailTask(existing); return; }
    setPresetContact(contact);
    setTaskDrawerOpen(true);
  };

  // Inline table edit, no drawer — reuses `updateClient` (a full PATCH) with
  // every other field carried over unchanged from the row's own data, since
  // the route always writes the whole record. Changing status here can move
  // a contact off the page it's currently on (Proses -> Deal or back), which
  // is exactly what `updateClient`'s own `revalidatePath` on both already
  // triggers — `router.refresh()` just makes this component pick that up
  // without a full navigation.
  const changeClientStatus = async (c: Contact, clientStatus: 'on_progress' | 'deal') => {
    setSavingStatusId(c.id);
    setStatusError(null);
    try {
      const fd = new FormData();
      fd.set('csrf', csrf);
      fd.set('id', c.id);
      fd.set('displayName', c.displayName ?? '');
      fd.set('phone', c.phone ?? '');
      fd.set('email', c.email ?? '');
      fd.set('igUsername', c.igUsername ?? '');
      fd.set('tags', c.tags.join(', '));
      fd.set('address', c.address ?? '');
      fd.set('notes', c.notes ?? '');
      fd.set('storeName', c.storeName ?? '');
      fd.set('storeStatus', c.storeStatus ?? '');
      fd.set('scheduleMeeting', c.scheduleMeeting ?? '');
      fd.set('clientStatus', clientStatus);
      const res = await updateClient(null, fd);
      if (!res.ok) { setStatusError(res.error ?? t.client.failed); return; }
      router.refresh();
    } finally {
      setSavingStatusId(null);
    }
  };

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
    if (untagged.length > 0) out.push({ label: t.client.noLabel, rows: untagged });
    return out;
  }, [filtered, groupBy]);

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]));

  // The kanban card's own click opens the detail drawer, so the Chat button
  // (a real navigation) has to stop the click before it bubbles up and opens
  // the drawer on top of the navigation.
  const goToChat = (conversationId: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/obrolan/${conversationId}`);
  };

  // Same reasoning as goToChat — the button sits inside the card's own click area.
  const clickScheduleMeeting = (contact: { id: string; name: string }) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openScheduleMeeting(contact);
  };

  const renderKanbanCard = (c: Contact) => {
    const conversationId = conversationByContact[c.id];
    return (
      <div key={c.id} className="kanban-card" role="button" tabIndex={0}
           onClick={() => setDetailContact(c)}
           onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDetailContact(c); }}>
        <div className="kanban-card-top">
          <span className="kanban-avatar" aria-hidden>{initials(c.displayName)}</span>
          <div className="kanban-details">
            <b className="kanban-title">{c.displayName ?? c.phone ?? '—'}</b>
            <div className="kanban-subtitle mono">{c.phone ?? '—'}</div>
            {c.storeStatus ? (
              <div className="kanban-tags">
                <span className={STORE_STATUS_CHIP[c.storeStatus] ?? 'chip'}>
                  {t.client.storeStatusLabel[c.storeStatus] ?? c.storeStatus}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="kanban-card-bottom">
          <span className="dim" style={{ fontSize: 11 }}>{ago(c.lastSeenAt)}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost sm"
                  onClick={clickScheduleMeeting({ id: c.id, name: c.displayName ?? c.phone ?? '—' })}>
            {t.tasks.kindLabel.meeting}
          </button>
          <button type="button" className="btn ghost sm" disabled={!conversationId}
                  title={conversationId ? undefined : t.client.noChat}
                  onClick={conversationId ? goToChat(conversationId) : undefined}>
            {t.client.chat}
          </button>
        </div>
      </div>
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
          <button type="button" onClick={() => setDetailContact(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none',
                    padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left',
                  }}>
            <span className="avatar" aria-hidden>{initials(c.displayName)}</span>
            <b>{c.displayName ?? c.phone ?? '—'}</b>
          </button>
        </td>
        <td>
          <select className="line-input sm" value={c.clientStatus} disabled={savingStatusId === c.id}
                  aria-label={t.client.clientStatus}
                  onChange={(e) => void changeClientStatus(c, e.target.value as 'on_progress' | 'deal')}>
            {Object.entries(t.client.clientStatusLabel).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </td>
        <td className="mono">{c.phone ?? '—'}</td>
        <td>{c.storeName || <span className="dim">—</span>}</td>
        <td>
          {c.storeStatus ? (
            <span className={STORE_STATUS_CHIP[c.storeStatus] ?? 'chip'}>
              {t.client.storeStatusLabel[c.storeStatus] ?? c.storeStatus}
            </span>
          ) : <span className="dim">—</span>}
        </td>
        <td>{formatMeeting(meetingByContact[c.id]?.dueAt ?? null)}</td>
        <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={c.notes ?? undefined}>
          {c.notes || <span className="dim">—</span>}
        </td>
        <td className="num">{ago(c.lastSeenAt)}</td>
        <td style={{ textAlign: 'center' }}>
          {conversationId ? (
            <Link href={`/obrolan/${conversationId}`} className="btn ghost sm">{t.client.chat}</Link>
          ) : (
            <button type="button" className="btn ghost sm" disabled title={t.client.noChat}>
              {t.client.chat}
            </button>
          )}
        </td>
        <td style={{ textAlign: 'center' }}>
          <ClientRowActions id={c.id} name={c.displayName ?? c.phone ?? '—'}
                            onOpenDetail={() => setDetailContact(c)} onScheduleMeeting={openScheduleMeeting} />
        </td>
      </tr>
    );
  };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.client.searchPlaceholder} aria-label={t.client.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" onClick={() => setAddClientOpen(true)}>
              {t.client.add}
            </button>
            <button type="button" className="btn ghost" onClick={() => { setPresetContact(null); setTaskDrawerOpen(true); }}>
              {t.client.scheduleMeeting}
            </button>
          </div>
          <div className="odoo-cp-right">
            <span className="dim tnum" style={{ fontSize: 12.5, marginRight: 8 }}>
              {filtered.length} {t.client.title.toLowerCase()}
            </span>

            <details className="dropdown" ref={filterRef} onToggle={(e) => e.currentTarget.open && closeOthers('filter')}>
              <summary className="btn ghost sm">
                {t.client.filters}{activeTags.length > 0 ? ` (${activeTags.length})` : ''}
              </summary>
              <div className="dropdown-body vertical">
                {availableTags.length === 0 ? (
                  <p className="dim" style={{ fontSize: 12.5, padding: '4px 6px' }}>{t.client.noFilters}</p>
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
                {t.client.groupBy}{groupBy !== 'none' ? ' •' : ''}
              </summary>
              <div className="dropdown-body vertical">
                <label className="dropdown-check">
                  <input type="radio" name="client-groupby" checked={groupBy === 'none'}
                         onChange={() => setGroupBy('none')} />
                  {t.client.noGroup}
                </label>
                <label className="dropdown-check">
                  <input type="radio" name="client-groupby" checked={groupBy === 'tag'}
                         onChange={() => setGroupBy('tag')} />
                  {t.client.groupByTag}
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
        {statusError ? <p className="error" style={{ marginBottom: 10 }}>{statusError}</p> : null}
        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {contacts.length === 0 ? emptyMessage : t.client.noMatches}
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
                        <th>{t.client.name}</th>
                        <th>{t.client.clientStatus}</th>
                        <th>{t.client.phone}</th>
                        <th>{t.client.storeName}</th>
                        <th>{t.client.storeStatus}</th>
                        <th>{t.client.scheduleMeeting}</th>
                        <th>{t.client.notes}</th>
                        <th className="num">{t.client.lastSeen}</th>
                        <th style={{ textAlign: 'center' }}>{t.client.chat}</th>
                        <th style={{ textAlign: 'center' }}>{t.client.actions}</th>
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

      <ClientQuickAddTaskDrawer open={taskDrawerOpen} onClose={() => { setTaskDrawerOpen(false); setPresetContact(null); }}
                                contacts={contacts} presetContact={presetContact} />
      <ClientMeetingDetailDrawer task={detailTask} open={detailTask !== null} onClose={() => setDetailTask(null)} />
      <ClientAddDrawer open={addClientOpen} onClose={() => setAddClientOpen(false)} />
      <ClientDetailDrawer contact={detailContact} nextMeeting={detailContact ? meetingByContact[detailContact.id] ?? null : null}
                          open={detailContact !== null} onClose={() => setDetailContact(null)} />
    </>
  );
}
