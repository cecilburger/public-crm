'use client';

import { useActionState } from 'react';
import { saveMessageTemplate, removeMessageTemplate, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { MessageTemplate } from '@/lib/api';

const CATEGORIES: MessageTemplate['category'][] = ['marketing', 'utility', 'authentication'];
const STATUSES: MessageTemplate['status'][] = ['draft', 'pending', 'approved', 'rejected'];

/**
 * Every row is its own form — same pattern as the product catalogue. No
 * modal, no separate edit screen, and it works with JavaScript switched off.
 */
export function MessageTemplateEditor({ templates }: { templates: MessageTemplate[] }) {
  const [saved, save, saving] = useActionState<ActionResult | null, FormData>(saveMessageTemplate, null);
  const [, remove] = useActionState<ActionResult | null, FormData>(removeMessageTemplate, null);

  return (
    <div className="panel">
      <header>
        <h2>{t.messageTemplate.title}</h2>
        <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.messageTemplate.hint}</span>
      </header>

      <div className="body stack" style={{ gap: 10 }}>
        {saved?.error ? <p className="error">{saved.error}</p> : null}

        {templates.length === 0 ? (
          <p className="dim" style={{ fontSize: 13 }}>{t.messageTemplate.empty}</p>
        ) : templates.map((tpl) => (
          <form key={tpl.id} action={save} className="rowform">
            <CsrfField />
            <input type="hidden" name="id" value={tpl.id} />
            <label><span className="mono dim">{t.messageTemplate.name}</span>
              <input className="input" name="name" defaultValue={tpl.name} required /></label>
            <label style={{ maxWidth: 150 }}><span className="mono dim">{t.messageTemplate.category}</span>
              <select className="input" name="category" defaultValue={tpl.category}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{t.messageTemplate.categoryLabel[c]}</option>)}
              </select></label>
            <label style={{ maxWidth: 90 }}><span className="mono dim">{t.messageTemplate.language}</span>
              <input className="input" name="language" defaultValue={tpl.language} /></label>
            <label style={{ maxWidth: 160 }}><span className="mono dim">{t.messageTemplate.status}</span>
              <select className="input" name="status" defaultValue={tpl.status}>
                {STATUSES.map((s) => <option key={s} value={s}>{t.messageTemplate.statusLabel[s]}</option>)}
              </select></label>
            <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.messageTemplate.body}</span>
              <textarea className="input" name="body" rows={2} defaultValue={tpl.body} required /></label>
            <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.messageTemplate.notes}</span>
              <input className="input" name="notes" defaultValue={tpl.notes ?? ''}
                     placeholder={t.messageTemplate.notesPlaceholder} /></label>
            <button className="btn sm" type="submit" disabled={saving}>{t.messageTemplate.save}</button>
            <button className="btn ghost sm" type="submit" formAction={remove}>{t.messageTemplate.remove}</button>
          </form>
        ))}

        <form action={save} className="rowform addrow">
          <CsrfField />
          <label><span className="mono dim">{t.messageTemplate.name}</span>
            <input className="input" name="name" placeholder={t.messageTemplate.namePlaceholder} required /></label>
          <label style={{ maxWidth: 150 }}><span className="mono dim">{t.messageTemplate.category}</span>
            <select className="input" name="category" defaultValue="utility">
              {CATEGORIES.map((c) => <option key={c} value={c}>{t.messageTemplate.categoryLabel[c]}</option>)}
            </select></label>
          <label style={{ maxWidth: 90 }}><span className="mono dim">{t.messageTemplate.language}</span>
            <input className="input" name="language" defaultValue="id" /></label>
          <label style={{ maxWidth: 160 }}><span className="mono dim">{t.messageTemplate.status}</span>
            <select className="input" name="status" defaultValue="draft">
              {STATUSES.map((s) => <option key={s} value={s}>{t.messageTemplate.statusLabel[s]}</option>)}
            </select></label>
          <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.messageTemplate.body}</span>
            <textarea className="input" name="body" rows={2} placeholder={t.messageTemplate.bodyPlaceholder} required /></label>
          <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.messageTemplate.notes}</span>
            <input className="input" name="notes" placeholder={t.messageTemplate.notesPlaceholder} /></label>
          <button className="btn primary sm" type="submit" disabled={saving}>
            {saving ? t.messageTemplate.saving : t.messageTemplate.add}
          </button>
        </form>
      </div>
    </div>
  );
}
