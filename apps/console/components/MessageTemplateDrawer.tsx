'use client';

import { useActionState, useEffect, useState } from 'react';
import { saveMessageTemplate, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { MessageTemplate } from '@/lib/api';

const CHANNELS: MessageTemplate['channel'][] = ['whatsapp', 'email', 'other'];
const CATEGORIES: MessageTemplate['category'][] = ['marketing', 'utility', 'authentication'];
const STATUSES: MessageTemplate['status'][] = ['draft', 'pending', 'approved', 'rejected'];

/**
 * One drawer, two callers — same slide-in chrome as Tugas: blank for a new
 * template, filled in when opened from a row. `saveMessageTemplate` already
 * branches create/update on whether `id` is present, so this just decides
 * which hidden field (and which starting values) to render.
 *
 * Category and approval Status are Meta's own WhatsApp template concepts —
 * they only mean anything for a WhatsApp template, so an Email/Lainnya one
 * hides them rather than asking for a fake category.
 */
export function MessageTemplateDrawer({
  open, template, onClose,
}: { open: boolean; template: MessageTemplate | null; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(saveMessageTemplate, null);
  const [channel, setChannel] = useState<MessageTemplate['channel']>(template?.channel ?? 'whatsapp');

  useEffect(() => {
    if (open) setChannel(template?.channel ?? 'whatsapp');
  }, [open, template]);

  useEffect(() => {
    if (state?.ok) onClose();
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const title = template ? t.messageTemplate.detailTitle : t.messageTemplate.newTitle;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={title} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.messageTemplate.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form key={template?.id ?? 'new'} action={formAction}
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          {template ? <input type="hidden" name="id" value={template.id} /> : null}

          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label htmlFor="mt-name">{t.messageTemplate.name}</label>
                <input className="line-input" id="mt-name" name="name" required
                       defaultValue={template?.name ?? ''} placeholder={t.messageTemplate.namePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="mt-channel">{t.messageTemplate.channel}</label>
                <select className="line-input" id="mt-channel" name="channel" value={channel}
                        onChange={(e) => setChannel(e.target.value as MessageTemplate['channel'])}>
                  {CHANNELS.map((c) => <option key={c} value={c}>{t.messageTemplate.channelLabel[c]}</option>)}
                </select>
                <p className="record-hint">{t.messageTemplate.channelHint}</p>
              </div>

              {channel === 'whatsapp' ? (
                <>
                  <div className="record-field">
                    <label htmlFor="mt-category">{t.messageTemplate.category}</label>
                    <select className="line-input" id="mt-category" name="category"
                            defaultValue={template?.category ?? 'utility'}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{t.messageTemplate.categoryLabel[c]}</option>)}
                    </select>
                  </div>
                  <div className="record-field">
                    <label htmlFor="mt-status">{t.messageTemplate.status}</label>
                    <select className="line-input" id="mt-status" name="status"
                            defaultValue={template?.status ?? 'draft'}>
                      {STATUSES.map((s) => <option key={s} value={s}>{t.messageTemplate.statusLabel[s]}</option>)}
                    </select>
                  </div>
                </>
              ) : null}

              <div className="record-field">
                <label htmlFor="mt-language">{t.messageTemplate.language}</label>
                <input className="line-input" id="mt-language" name="language" defaultValue={template?.language ?? 'id'} />
              </div>

              <div className="record-field">
                <label htmlFor="mt-body">{t.messageTemplate.body}</label>
                <textarea className="line-input" id="mt-body" name="body" rows={4} required
                          defaultValue={template?.body ?? ''} placeholder={t.messageTemplate.bodyPlaceholder} />
                {channel === 'whatsapp' ? <p className="record-hint">{t.messageTemplate.hint}</p> : null}
              </div>

              <div className="record-field">
                <label htmlFor="mt-notes">{t.messageTemplate.notes}</label>
                <textarea className="line-input" id="mt-notes" name="notes" rows={2}
                          defaultValue={template?.notes ?? ''} placeholder={t.messageTemplate.notesPlaceholder} />
              </div>
            </div>

            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.messageTemplate.saving : t.messageTemplate.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.messageTemplate.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
