'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { sendMessage, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

function SendButton({ windowOpen }: { windowOpen: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={pending}>
      {pending ? t.chats.sending : windowOpen ? t.chats.send : t.chats.sendTemplate}
    </button>
  );
}

/**
 * The composer knows WhatsApp's 24-hour rule and explains it in one sentence,
 * before the agent types a reply that cannot be delivered — and it says the rule
 * comes from WhatsApp, so nobody blames the tool for it.
 */
export function Composer({
  conversationId, windowOpen, customerName,
}: { conversationId: string; windowOpen: boolean; customerName: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(sendMessage, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);

  return (
    <form className="composer" action={action} ref={ref}>
      <CsrfField />
      <input type="hidden" name="conversationId" value={conversationId} />

      {!windowOpen ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden>!</span>
          <span>
            <strong>{t.chats.windowClosedTitle}</strong>
            <br />{t.chats.windowClosedBody}
          </span>
        </div>
      ) : null}

      {state?.error ? <p className="error" role="alert" style={{ marginBottom: 10 }}>{state.error}</p> : null}

      <textarea
        className="textarea"
        name="body"
        required
        placeholder={windowOpen ? `${t.chats.writeReply.replace('…', '')} untuk ${customerName}…` : t.chats.writeTemplate}
        aria-label={t.chats.writeReply}
      />

      <div className="row">
        {!windowOpen ? (
          <span className="field" style={{ maxWidth: 300 }}>
            <label htmlFor="templateName">{t.chats.templateName}</label>
            <input className="input" id="templateName" name="templateName" required
                   placeholder={t.chats.templateNameHint} />
          </span>
        ) : (
          <span className="mono dim">{t.chats.freeform}</span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <SendButton windowOpen={windowOpen} />
      </div>
    </form>
  );
}
