'use client';

import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
import { createTask, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { TaskKindField } from '@/components/TaskKindField';
import type { Brand, Member, Deal, TaskKind } from '@/lib/api';

/**
 * The "Tambah Tugas" button on a Brand's own page — same slide-in shell as
 * the Tugas page's own quick-add drawer, but the brand is fixed (no picker,
 * this page already is one), and saving redirects to Tugas instead of just
 * closing the panel — `createTask` (not `createTaskInline`) is what does that.
 */
export function BrandTaskDrawer({
  open, onClose, brand, members, deals, taskKinds,
}: {
  open: boolean;
  onClose: () => void;
  brand: Brand;
  members: Member[];
  deals: Deal[];
  taskKinds: TaskKind[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTask, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState('follow_up');
  const [repeatUnit, setRepeatUnit] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.tasks.newTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.tasks.newTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form ref={formRef} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <input type="hidden" name="brandId" value={brand.id} />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{t.tasks.formBrand}</label>
                <p style={{ margin: 0 }}>{brand.name}</p>
              </div>

              <div className="record-field">
                <label htmlFor="bd-title">{t.tasks.formTitle}</label>
                <input className="line-input" id="bd-title" name="title" required
                       placeholder={t.tasks.titlePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="bd-dueAt">{t.tasks.formDueAt}</label>
                <input className="line-input" id="bd-dueAt" name="dueAt" type="datetime-local" required />
              </div>

              <TaskKindField id="bd-kind" name="kind" value={kind} onChange={setKind} initialCustomKinds={taskKinds} />

              {kind === 'meeting' ? (
                <div className="record-field">
                  <label htmlFor="bd-meetingLink">{t.tasks.formMeetingLink}</label>
                  <input className="line-input" id="bd-meetingLink" name="meetingLink" type="url"
                         placeholder={t.tasks.meetingLinkPlaceholder} />
                </div>
              ) : null}

              <div className="record-field">
                <label htmlFor="bd-priority">{t.tasks.formPriority}</label>
                <select className="line-input" id="bd-priority" name="priority" defaultValue="medium">
                  {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                    <option key={p} value={p}>{t.tasks.priorityLabel[p]}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="bd-repeatUnit">{t.tasks.repeat}</label>
                <select className="line-input" id="bd-repeatUnit" name="repeatUnit" value={repeatUnit}
                        onChange={(e) => setRepeatUnit(e.target.value)}>
                  <option value="">{t.tasks.repeatNone}</option>
                  {(['day', 'week', 'month', 'year'] as const).map((u) => (
                    <option key={u} value={u}>{t.tasks.repeatUnitLabel[u]}</option>
                  ))}
                </select>
              </div>

              {repeatUnit ? (
                <>
                  <div className="record-field">
                    <label htmlFor="bd-repeatInterval">{t.tasks.repeatEvery}</label>
                    <input className="line-input" id="bd-repeatInterval" name="repeatInterval" type="number"
                           min={1} max={365} defaultValue={1} />
                  </div>
                  <div className="record-field">
                    <label htmlFor="bd-repeatUntil">{t.tasks.repeatUntil}</label>
                    <input className="line-input" id="bd-repeatUntil" name="repeatUntil" type="date" />
                    <p className="record-hint">{t.tasks.repeatUntilHint}</p>
                  </div>
                </>
              ) : null}

              <div className="record-field">
                <label htmlFor="bd-assigneeId">{t.tasks.formAssignee}</label>
                <select className="line-input" id="bd-assigneeId" name="assigneeId" defaultValue="">
                  <option value="">{t.tasks.unassigned}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="bd-dealId">{t.tasks.formDeal}</label>
                <select className="line-input" id="bd-dealId" name="dealId" defaultValue="">
                  <option value="">{t.tasks.noDeal}</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.brand_name ? ` — ${d.brand_name}` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="bd-notes">{t.tasks.formNotes}</label>
                <textarea className="line-input" id="bd-notes" name="notes" rows={3}
                          placeholder={t.tasks.notesPlaceholder} />
              </div>
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.tasks.saving : t.tasks.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.client.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
