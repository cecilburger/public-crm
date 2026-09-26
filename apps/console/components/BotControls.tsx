'use client';

import { useActionState } from 'react';
import { takeoverConversation, resumeBot, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { botActions, escalationLabel, type Handling } from '@/lib/chatbot';

const CHIP_CLASS: Record<Handling, string> = { bot: 'chip accent', human: 'chip', needs_human: 'chip danger' };

/**
 * Who is answering a thread the trained-cb bot owns, and the two hand-offs
 * between it and a person. Rendered only on a bot-owned conversation; every
 * other thread keeps the header it always had.
 */
export function BotControls({ conversationId, handling, optOut, escalationReason }: {
  conversationId: string;
  handling: Handling;
  optOut: boolean;
  escalationReason: string | null;
}) {
  const [takeoverState, takeover, takingOver] =
    useActionState<ActionResult | null, FormData>(takeoverConversation, null);
  const [resumeState, resume, resuming] = useActionState<ActionResult | null, FormData>(resumeBot, null);

  const { canTakeover, canResume } = botActions({ chatbot_owned: true, handling, opt_out: optOut });
  const reason = escalationLabel(escalationReason, t.chatbot.reasons);
  const error = takeoverState?.error ?? resumeState?.error;
  const pending = takingOver || resuming;

  return (
    <>
      <span className={CHIP_CLASS[handling]}>{t.chatbot.handling[handling] ?? handling}</span>
      {reason ? (
        <span className="dim" title={reason}
              style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {reason}
        </span>
      ) : null}
      {optOut ? <span className="chip warn" title={t.chatbot.optOutHint}>{t.chatbot.optOut}</span> : null}

      {canTakeover ? (
        <form action={takeover}>
          <CsrfField />
          <input type="hidden" name="conversationId" value={conversationId} />
          <button className="btn primary sm" type="submit" disabled={pending}>
            {takingOver ? t.chatbot.working : t.chatbot.takeover}
          </button>
        </form>
      ) : null}
      {canResume ? (
        <form action={resume}>
          <CsrfField />
          <input type="hidden" name="conversationId" value={conversationId} />
          <button className="btn sm" type="submit" disabled={pending}>
            {resuming ? t.chatbot.working : t.chatbot.resume}
          </button>
        </form>
      ) : null}
      {error ? <span className="dim" role="alert" style={{ color: 'var(--danger)', fontSize: 11.5 }}>{error}</span> : null}
    </>
  );
}
