'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { sendMessage, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { QuickReply } from '@/lib/api';

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
  conversationId, windowOpen, customerName, quickReplies = [],
}: { conversationId: string; windowOpen: boolean; customerName: string; quickReplies?: QuickReply[] }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(sendMessage, null);
  const ref = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);

  // The textarea is uncontrolled on purpose (see below), so a snippet is
  // spliced into it at the cursor the same way a browser's own paste would.
  function insertQuickReply(body: string) {
    const el = textareaRef.current;
    if (pickerRef.current) pickerRef.current.open = false;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = `${el.value.slice(0, start)}${body}${el.value.slice(end)}`;
    const caret = start + body.length;
    el.focus();
    el.setSelectionRange(caret, caret);
  }

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
        ref={textareaRef}
        className="textarea"
        name="body"
        required
        placeholder={windowOpen ? `${t.chats.writeReply.replace('…', '')} untuk ${customerName}…` : t.chats.writeTemplate}
        aria-label={t.chats.writeReply}
      />

      <div className="row">
        {windowOpen ? (
          <details className="dropdown" ref={pickerRef}>
            <summary className="btn ghost sm">{t.chats.quickReplyButton}</summary>
            <div className="dropdown-body vertical upward qr-list">
              {quickReplies.length === 0 ? (
                <p className="dim" style={{ fontSize: 12.5, padding: '4px 6px' }}>{t.chats.quickReplyEmpty}</p>
              ) : quickReplies.map((qr) => (
                <button key={qr.id} type="button" className="dropdown-check qr-item"
                        onClick={() => insertQuickReply(qr.body)}>
                  <span className="qr-item-title">{qr.title}</span>
                  <span className="qr-item-body dim">{qr.body}</span>
                </button>
              ))}
            </div>
          </details>
        ) : null}
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
