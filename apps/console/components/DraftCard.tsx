'use client';

import { useActionState, useState } from 'react';
import { decideDraft, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import type { AutopilotDraft } from '@/lib/api';
import { CsrfField } from '@/components/Csrf';

/**
 * A draft is a proposal, and the UI says so.
 *
 * Three choices, in the order a person actually wants them: send it, change it
 * first, or bin it. Nothing is pre-selected and nothing happens on a timer —
 * the customer only ever hears from us because someone decided.
 */
export function DraftCard({ conversationId, draft }: { conversationId: string; draft: AutopilotDraft }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(decideDraft, null);
  const [editing, setEditing] = useState(false);
  const percent = Math.round(draft.confidence * 100);

  return (
    <div className="draft">
      <div className="draft-head">
        <span className="draft-mark" aria-hidden>AI</span>
        <strong>{t.autopilot.ready}</strong>
        <span className="chip brand">{percent}% {t.autopilot.confidence}</span>
        <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.autopilot.explain}</span>
      </div>

      <form action={action}>
        <CsrfField />
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="draftId" value={draft.id} />

        {editing ? (
          <textarea className="textarea" name="body" defaultValue={draft.body} aria-label={t.autopilot.edit} />
        ) : (
          <p className="draft-body">{draft.body}</p>
        )}

        {state?.error ? <p className="error" style={{ marginTop: 10 }}>{state.error}</p> : null}

        <div className="draft-actions">
          <button className="btn primary" type="submit" name="action" value="use" disabled={pending}>
            {pending ? t.autopilot.working : editing ? t.autopilot.sendEdited : t.autopilot.use}
          </button>
          {editing ? (
            <button className="btn" type="button" onClick={() => setEditing(false)} disabled={pending}>
              {t.autopilot.cancelEdit}
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => setEditing(true)} disabled={pending}>
              {t.autopilot.edit}
            </button>
          )}
          <button className="btn ghost" type="submit" name="action" value="discard" disabled={pending}>
            {t.autopilot.discard}
          </button>
        </div>
      </form>
    </div>
  );
}
