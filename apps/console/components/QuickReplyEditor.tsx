'use client';

import { useActionState } from 'react';
import { saveQuickReply, removeQuickReply, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { QuickReply } from '@/lib/api';

/**
 * Every row is its own form — same pattern as the message template editor.
 * No modal, no separate edit screen, and it works with JavaScript switched off.
 */
export function QuickReplyEditor({ quickReplies }: { quickReplies: QuickReply[] }) {
  const [saved, save, saving] = useActionState<ActionResult | null, FormData>(saveQuickReply, null);
  const [, remove] = useActionState<ActionResult | null, FormData>(removeQuickReply, null);

  return (
    <div className="panel">
      <header>
        <h2>{t.quickReply.title}</h2>
      </header>

      <div className="body stack" style={{ gap: 10 }}>
        {saved?.error ? <p className="error">{saved.error}</p> : null}

        {quickReplies.length === 0 ? (
          <p className="dim" style={{ fontSize: 13 }}>{t.quickReply.empty}</p>
        ) : quickReplies.map((qr) => (
          <form key={qr.id} action={save} className="rowform">
            <CsrfField />
            <input type="hidden" name="id" value={qr.id} />
            <label><span className="mono dim">{t.quickReply.name}</span>
              <input className="input" name="title" defaultValue={qr.title} required /></label>
            <label style={{ maxWidth: 150 }}><span className="mono dim">{t.quickReply.shortcut}</span>
              <input className="input" name="shortcut" defaultValue={qr.shortcut ?? ''}
                     placeholder={t.quickReply.shortcutPlaceholder} /></label>
            <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.quickReply.body}</span>
              <textarea className="input" name="body" rows={2} defaultValue={qr.body} required /></label>
            <button className="btn sm" type="submit" disabled={saving}>{t.quickReply.save}</button>
            <button className="btn ghost sm" type="submit" formAction={remove}>{t.quickReply.remove}</button>
          </form>
        ))}

        <form action={save} className="rowform addrow">
          <CsrfField />
          <label><span className="mono dim">{t.quickReply.name}</span>
            <input className="input" name="title" placeholder={t.quickReply.namePlaceholder} required /></label>
          <label style={{ maxWidth: 150 }}><span className="mono dim">{t.quickReply.shortcut}</span>
            <input className="input" name="shortcut" placeholder={t.quickReply.shortcutPlaceholder} /></label>
          <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.quickReply.body}</span>
            <textarea className="input" name="body" rows={2} placeholder={t.quickReply.bodyPlaceholder} required /></label>
          <button className="btn primary sm" type="submit" disabled={saving}>
            {saving ? t.quickReply.saving : t.quickReply.add}
          </button>
        </form>
      </div>
    </div>
  );
}
