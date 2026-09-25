'use client';

import { useActionState } from 'react';
import { saveChatbotEnabled, saveChannelChatbot, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

const OPTIONS = [
  { value: 'true', label: t.chatbot.on, note: t.chatbot.onNote },
  { value: 'false', label: t.chatbot.off, note: t.chatbot.offNote },
];

/**
 * The division's switch, written like Autopilot's mode picker: letting a bot
 * answer customers is a decision, so each choice says what it does.
 */
export function ChatbotSwitch({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveChatbotEnabled, null);

  return (
    <form className="panel" action={action}>
      <header><h2>{t.chatbot.switchTitle}</h2></header>
      <div className="body">
        <CsrfField />
        <div className="modes">
          {OPTIONS.map((option) => (
            <label key={option.value} className="mode">
              <input type="radio" name="enabled" value={option.value}
                     defaultChecked={String(enabled) === option.value} />
              <span>
                <b>{option.label}</b>
                <span className="muted">{option.note}</span>
              </span>
            </label>
          ))}
        </div>
        {state?.error ? <p className="error" style={{ marginTop: 12 }}>{state.error}</p> : null}
        {state?.ok ? <p className="ok" style={{ marginTop: 12 }}>{t.chatbot.saved}</p> : null}
        <button className="btn primary" type="submit" disabled={pending} style={{ marginTop: 14 }}>
          {pending ? t.chatbot.saving : t.chatbot.save}
        </button>
      </div>
    </form>
  );
}

/** One account's own opt-in, saved from its table row — same shape as the per-number daily limit. */
export function ChannelChatbotToggle({ channelId, enabled }: { channelId: string; enabled: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveChannelChatbot, null);

  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <CsrfField />
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className={enabled ? 'chip good' : 'chip'}>{enabled ? t.chatbot.channelOn : t.chatbot.channelOff}</span>
        <button className="btn ghost sm" type="submit" disabled={pending}>
          {enabled ? t.chatbot.turnOff : t.chatbot.turnOn}
        </button>
      </span>
      {state?.error ? <span className="dim" style={{ color: 'var(--danger)', fontSize: 11.5 }}>{state.error}</span> : null}
    </form>
  );
}
