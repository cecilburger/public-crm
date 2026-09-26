import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  senderLabelKey, isMachineWritten, isUndelivered, botActions, inboxBotChip, chatAttention, escalationLabel,
  replyWindowOpen,
} from '../apps/console/lib/chatbot.ts';
import { t } from '../apps/console/lib/copy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('who a message bubble says wrote it', () => {
  it('labels a trained-cb reply as the bot', () => {
    expect(senderLabelKey({ senderType: 'bot', senderId: null })).toBe('bot');
  });

  it('tells an approved Autopilot draft apart from one Autopilot sent by itself', () => {
    expect(senderLabelKey({ senderType: 'autopilot', senderId: 'u1' })).toBe('autopilotApproved');
    expect(senderLabelKey({ senderType: 'autopilot', senderId: null })).toBe('autopilotAuto');
    expect(senderLabelKey({ senderType: 'autopilot' })).toBe('autopilotAuto');
  });

  it('keeps the contact, agent and system labels as they were', () => {
    expect(senderLabelKey({ senderType: 'contact', senderId: null })).toBe('contact');
    expect(senderLabelKey({ senderType: 'agent', senderId: 'u1' })).toBe('agent');
    expect(senderLabelKey({ senderType: 'system', senderId: null })).toBe('system');
  });

  it('passes an unknown sender type through for the caller to fall back on', () => {
    expect(senderLabelKey({ senderType: 'something-new' })).toBe('something-new');
  });

  it('gives bot and Autopilot bubbles the machine-written style, and nobody else', () => {
    expect(isMachineWritten({ senderType: 'bot' })).toBe(true);
    expect(isMachineWritten({ senderType: 'autopilot', senderId: 'u1' })).toBe(true);
    expect(isMachineWritten({ senderType: 'agent' })).toBe(false);
    expect(isMachineWritten({ senderType: 'contact' })).toBe(false);
  });

  it('marks only an outbound message that failed as not delivered', () => {
    expect(isUndelivered({ direction: 'outbound', status: 'failed' })).toBe(true);
    expect(isUndelivered({ direction: 'outbound', status: 'queued' })).toBe(false);
    expect(isUndelivered({ direction: 'outbound', status: 'sent' })).toBe(false);
    expect(isUndelivered({ direction: 'inbound', status: 'failed' })).toBe(false);
  });
});

describe('the hand-off buttons on a thread', () => {
  const owned = { chatbot_owned: true, opt_out: false };

  it('offers only a takeover while the bot is answering', () => {
    expect(botActions({ ...owned, handling: 'bot' })).toEqual({ canTakeover: true, canResume: false });
  });

  it('offers only a resume once a person has taken over', () => {
    expect(botActions({ ...owned, handling: 'human' })).toEqual({ canTakeover: false, canResume: true });
  });

  it('offers both when the bot asked for help', () => {
    expect(botActions({ ...owned, handling: 'needs_human' })).toEqual({ canTakeover: true, canResume: true });
  });

  it('never offers the bot back to a contact who opted out', () => {
    expect(botActions({ chatbot_owned: true, opt_out: true, handling: 'human' }))
      .toEqual({ canTakeover: false, canResume: false });
    expect(botActions({ chatbot_owned: true, opt_out: true, handling: 'needs_human' }).canResume).toBe(false);
  });

  it('offers nothing on a thread the bot does not own', () => {
    expect(botActions({ chatbot_owned: false, opt_out: false, handling: 'bot' }))
      .toEqual({ canTakeover: false, canResume: false });
  });
});

describe('why the bot asked for a person', () => {
  it('labels the reasons the CRM records, whoever holds the thread', () => {
    expect(escalationLabel('verify_booking', t.chatbot.reasons)).toBe(t.chatbot.reasons.verify_booking);
    expect(escalationLabel('booked_during_takeover', t.chatbot.reasons)).toMatch(/meeting/);
  });

  it('shows trained-cb\'s own reason as it is, and nothing without one', () => {
    expect(escalationLabel('price negotiation', t.chatbot.reasons)).toBe('price negotiation');
    expect(escalationLabel(null, t.chatbot.reasons)).toBeNull();
    expect(escalationLabel('', t.chatbot.reasons)).toBeNull();
  });
});

describe('the inbox chip', () => {
  it('shows Bot or Perlu bantuan only on a bot-owned thread', () => {
    expect(inboxBotChip({ chatbot_owned: true, handling: 'bot' })).toBe('bot');
    expect(inboxBotChip({ chatbot_owned: true, handling: 'needs_human' })).toBe('needs_human');
    expect(inboxBotChip({ chatbot_owned: true, handling: 'human' })).toBeNull();
    expect(inboxBotChip({ chatbot_owned: false, handling: 'needs_human' })).toBeNull();
    expect(inboxBotChip({})).toBeNull();
  });
});

describe('the notification a conversation raises', () => {
  const open = { status: 'open', chatbot_owned: true };

  it('raises one bot-needs-help item instead of two when the thread is also awaiting a reply', () => {
    expect(chatAttention({ ...open, handling: 'needs_human' }, true)).toBe('bot_needs_help');
    expect(chatAttention({ ...open, handling: 'needs_human' }, false)).toBe('bot_needs_help');
  });

  it('keeps the plain awaiting-reply item for everything else', () => {
    expect(chatAttention({ ...open, handling: 'bot' }, true)).toBe('needs_reply');
    expect(chatAttention({ status: 'open', chatbot_owned: false, handling: 'needs_human' }, true)).toBe('needs_reply');
    expect(chatAttention({ status: 'open' }, true)).toBe('needs_reply');
  });

  it('raises nothing for a resolved or answered thread', () => {
    expect(chatAttention({ ...open, status: 'resolved', handling: 'needs_human' }, false)).toBeNull();
    expect(chatAttention({ ...open, handling: 'bot' }, false)).toBeNull();
  });
});

describe('the Messenger thread', () => {
  it('takes free text however long the contact has been quiet', () => {
    expect(replyWindowOpen({ channel_kind: 'messenger_bridge', serviceWindowOpen: false })).toBe(true);
    expect(replyWindowOpen({ channel_kind: 'whatsapp', serviceWindowOpen: false })).toBe(false);
    expect(replyWindowOpen({ channel_kind: 'whatsapp', serviceWindowOpen: true })).toBe(true);
  });

  it('no longer replaces the reply box, so a person can answer after a takeover', async () => {
    const page = await readFile(join(ROOT, 'apps/console/app/(app)/obrolan/[id]/page.tsx'), 'utf8');
    expect(page).not.toMatch(/disabledReason/);
    expect(page).not.toMatch(/replyUnavailable/);
  });
});
