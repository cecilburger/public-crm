import { api, type ChatbotOverview } from '@/lib/api';
import { num } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Handling } from '@/lib/chatbot';
import { SettingsTabs } from '@/components/SettingsTabs';
import { DivisionBadge } from '@/components/DivisionBadge';
import { ChatbotSwitch, ChannelChatbotToggle } from '@/components/ChatbotSwitch';

export const dynamic = 'force-dynamic';

const HANDLING_ORDER: Handling[] = ['bot', 'human', 'needs_human'];

const CHANNEL_STATUS_CHIP: Record<string, string> = {
  connected: 'chip good', connecting: 'chip warn', error: 'chip danger', disabled: 'chip',
};

/**
 * Pengaturan → Chatbot.
 *
 * The bot answers a DM only when both switches here are on: the division's,
 * and the account's own. There is no engine to pick — trained-cb is the only
 * one — and Autopilot keeps its own page for the Meta channels.
 */
export default async function ChatbotSettingsPage() {
  const overview = await api<ChatbotOverview>('/v1/chatbot');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.chatbot.title}</h1>
          <p className="subtitle">{t.chatbot.subtitle}</p>
        </div>
        <span className="spacer" />
        <DivisionBadge />
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        {overview.brainNotConfiguredRecently ? (
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }} aria-hidden>!</span>
            <span><b>{t.chatbot.brainMissingTitle}.</b> {t.chatbot.brainMissing}</span>
          </div>
        ) : null}

        <ChatbotSwitch enabled={overview.enabled} />

        <div className="panel">
          <header><h2>{t.chatbot.countsTitle}</h2></header>
          <div className="body">
            <div className="grid c3">
              {HANDLING_ORDER.map((h) => (
                <div key={h}>
                  <div className="bignum">{num(overview.counts[h] ?? 0)}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t.chatbot.handling[h]}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t.chatbot.channelsTitle}</h2></header>
          <div className="body stack" style={{ gap: 12 }}>
            <p className="record-hint" style={{ margin: 0 }}>{t.chatbot.channelsNote}</p>
            {!overview.enabled && overview.channels.some((c) => c.chatbotEnabled) ? (
              <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>{t.chatbot.divisionOffNote}</p>
            ) : null}
          </div>
          {overview.channels.length === 0 ? (
            <p className="empty">{t.chatbot.noChannels}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t.chatbot.channelName}</th>
                  <th>{t.chatbot.channelKind}</th>
                  <th>{t.chatbot.channelStatus}</th>
                  <th>{t.chatbot.channelChatbot}</th>
                </tr>
              </thead>
              <tbody>
                {overview.channels.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.displayName}</b></td>
                    <td>
                      {t.channels[c.kind] ?? c.kind}
                      {c.kind === 'messenger_bridge' && !c.chatbotEnabled ? (
                        <><br /><span className="dim" style={{ fontSize: 12 }}>{t.chatbot.messengerNote}</span></>
                      ) : null}
                    </td>
                    <td>
                      <span className={CHANNEL_STATUS_CHIP[c.status] ?? 'chip'}>
                        {t.chatbot.channelStatuses[c.status] ?? c.status}
                      </span>
                    </td>
                    <td><ChannelChatbotToggle channelId={c.id} enabled={c.chatbotEnabled} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
