/**
 * How the console reads the trained-cb chatbot's state on a conversation.
 *
 * Imports nothing, for the same reason as `inbox.ts`: the console's API client
 * is browser-typed and cannot be pulled into the test program. The shapes
 * below are the few fields read here; the API types satisfy them structurally.
 */

export type Handling = 'bot' | 'human' | 'needs_human';

interface MessageLike {
  senderType: string;
  senderId?: string | null;
}

interface BotOwnedLike {
  chatbot_owned?: boolean;
  handling?: string;
}

/**
 * The key into `t.chats.sender` for a bubble. `autopilot` rows mean two
 * different things: with a `senderId` a person approved an Autopilot draft;
 * without one Autopilot sent it by itself. An unknown sender type is passed
 * through for the caller's own fallback.
 */
export function senderLabelKey(m: MessageLike): string {
  if (m.senderType === 'autopilot') return m.senderId ? 'autopilotApproved' : 'autopilotAuto';
  return m.senderType;
}

/** Written by software rather than typed by a person — shown in the `.ai` bubble style. */
export function isMachineWritten(m: MessageLike): boolean {
  return m.senderType === 'bot' || m.senderType === 'autopilot';
}

export function isUndelivered(m: { direction: string; status: string }): boolean {
  return m.direction === 'outbound' && m.status === 'failed';
}

/**
 * Whether a thread in Obrolan can be answered in free text. Messenger threads
 * open there too, and the 24-hour template rule is Meta's own API's: the
 * bridge types into Business Suite like a person, and the API sends it
 * unguarded — a person who takes a thread over from the bot must not be asked
 * for a template name.
 */
export function replyWindowOpen(c: { channel_kind: string; serviceWindowOpen: boolean }): boolean {
  return c.channel_kind === 'messenger_bridge' || c.serviceWindowOpen;
}

/** Which of the two hand-off buttons a conversation offers. */
export function botActions(c: { chatbot_owned: boolean; handling: Handling; opt_out: boolean }): {
  canTakeover: boolean; canResume: boolean;
} {
  if (!c.chatbot_owned) return { canTakeover: false, canResume: false };
  return {
    canTakeover: c.handling !== 'human',
    // A contact who opted out stays with a person for good.
    canResume: c.handling !== 'bot' && !c.opt_out,
  };
}

/**
 * Why the bot asked for a person, whoever holds the thread now: the flow can
 * escalate (a price negotiation, a contract draft) and keep answering, and
 * that is exactly when nobody would otherwise notice. The API sends only the
 * reason from the bot's latest word, never one left over from earlier. A
 * reason the CRM did not name is trained-cb's own text, shown as it is.
 */
export function escalationLabel(reason: string | null, labels: Record<string, string>): string | null {
  if (!reason) return null;
  return labels[reason] ?? reason;
}

/** The inbox chip for a thread the bot owns; a thread a person has taken shows none. */
export function inboxBotChip(c: BotOwnedLike): 'bot' | 'needs_human' | null {
  if (!c.chatbot_owned) return null;
  if (c.handling === 'bot') return 'bot';
  if (c.handling === 'needs_human') return 'needs_human';
  return null;
}

/**
 * The single notification a conversation raises, if any. The bot asking for
 * help outranks "waiting for a reply" — both are usually true at once, and
 * listing the same chat twice would read as two people waiting.
 */
export function chatAttention(
  c: BotOwnedLike & { status: string }, awaitingReply: boolean,
): 'bot_needs_help' | 'needs_reply' | null {
  if (c.status !== 'resolved' && inboxBotChip(c) === 'needs_human') return 'bot_needs_help';
  return awaitingReply ? 'needs_reply' : null;
}
