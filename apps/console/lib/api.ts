import { redirect } from 'next/navigation';
import { getSession } from './session';
import type { Handling } from './chatbot';

export const API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';

export class ApiError extends Error {
  constructor(public status: number, public problem: { detail?: string; errors?: unknown } = {}) {
    super(problem.detail ?? `Request failed (${status})`);
  }
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  /** Reads are never cached: an inbox that is 30 seconds stale is a wrong inbox. */
  cache?: RequestCache;
  /** Which Marketing/AI division the request acts in; the API defaults to marketing when absent. */
  division?: string;
}

export async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.division ? { 'x-division': opts.division } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: opts.cache ?? 'no-store',
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

/**
 * The authenticated call used by every page and action. Middleware refreshes
 * expiring tokens before the request reaches here; a 401 that still gets through
 * means the session is genuinely gone, so we send the user to sign in rather
 * than rendering a half-empty page.
 */
export async function api<T>(path: string, opts: Omit<CallOptions, 'token'> = {}): Promise<T> {
  const { accessToken, division } = await getSession();
  if (!accessToken) redirect('/masuk');

  try {
    return await call<T>(path, { division, ...opts, token: accessToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/masuk?reason=expired');
    throw err;
  }
}

/* ------------------------------------------------------------------ types */

export type { DivisionKey } from './session';

export interface Division {
  id: string;
  key: 'marketing' | 'ai';
  name: string;
}

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  workspace: { name: string; slug: string; status: string };
  /** The division this request acted in — what the switcher shows as active. */
  division: Division & { chatbotEnabled?: boolean };
  /** Both divisions of the workspace, Marketing first. */
  divisions: Division[];
}

export type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'viewer';

export interface ConversationSummary {
  id: string;
  status: 'open' | 'pending' | 'snoozed' | 'resolved';
  priority: string;
  assignee_id: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  sla_due_at: string | null;
  display_name: string | null;
  phone: string | null;
  channel_kind: string;
  channel_id: string;
  contact_id: string;
  created_at: string;
  first_response_at: string | null;
  handling: Handling;
  /** True when trained-cb answers this thread (division on, account on, a DM bridge). */
  chatbot_owned: boolean;
}

export interface AutopilotDraft {
  id: string;
  body: string;
  confidence: number;
  intent: string | null;
  model: string | null;
}

export interface ConversationDetail {
  conversation: {
    id: string; status: string; assignee_id: string | null; contact_id: string;
    channel_id: string; last_inbound_at: string | null; autopilot_mode: string;
    /** Which channel this thread is on. The reply box is hidden for one that
     * cannot send — see `Composer`'s `disabledReason`. */
    channel_kind: string;
    serviceWindowOpen: boolean;
    handling: Handling;
    chatbot_owned: boolean;
    /** The contact asked the bot to stop; the bot cannot be switched back on here. */
    opt_out: boolean;
    last_escalation_reason: string | null;
  };
  contact: { displayName: string | null; phone: string | null; tags: string[] };
  draft: AutopilotDraft | null;
  orders: { code: string; status: string; shipArea: string | null; totalIdr: number; createdAt: string }[];
  messages: {
    id: string; direction: 'inbound' | 'outbound';
    /** `bot` is trained-cb; `autopilot` is legacy Autopilot. */
    senderType: 'contact' | 'agent' | 'autopilot' | 'system' | 'bot';
    /** Set on an `autopilot` row when a person approved the draft. */
    senderId: string | null;
    /** When the customer sent it, not when we received it. */
    status: string; at: string; body: string | null;
  }[];
}

export interface ChatbotChannel {
  id: string;
  kind: 'whatsapp_web' | 'instagram_bridge' | 'messenger_bridge';
  displayName: string;
  status: string;
  chatbotEnabled: boolean;
}

/** `GET /v1/chatbot` — the division's trained-cb switch and its DM accounts. */
export interface ChatbotOverview {
  enabled: boolean;
  channels: ChatbotChannel[];
  counts: Record<Handling, number>;
  brainNotConfiguredRecently: boolean;
}

export interface Member {
  id: string; name: string; email: string; role: Role; status: string; last_login_at: string | null;
}

export interface Deal {
  id: string; title: string; amount_idr: string | number; status: string;
  stage_id: string; stage: string; position: number; rots_at: string | null;
  owner_id: string | null; closed_at: string | null; contact_id: string | null; contact_name: string | null;
  brand_id: string | null; brand_name: string | null; brand_category: string | null;
  expected_close_on: string | null;
}

export interface Stage {
  id: string; pipeline_id: string; pipeline: string; name: string;
  position: number; is_won: boolean; is_lost: boolean;
}

export interface DealDetail {
  id: string; title: string; amountIdr: number; status: string; lostReason: string | null;
  stageId: string; stageName: string; pipelineId: string; pipelineName: string;
  isWon: boolean; isLost: boolean;
  contactId: string | null; contactName: string | null; contactPhone: string | null;
  ownerId: string | null; sourceConversationId: string | null;
  brandId: string | null; brandName: string | null; brandCategory: string | null;
  expectedCloseOn: string | null; notes: string | null;
  rotsAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string;
}

export interface DealOrderSummary {
  id: string; code: string; status: string; totalIdr: number; shipArea: string | null; createdAt: string;
}

export interface DealActivityRow {
  id: number; actorType: string; actorId: string | null; action: string;
  meta: Record<string, unknown>; createdAt: string;
}

export interface DealDetailResponse {
  deal: DealDetail;
  orders: DealOrderSummary[];
  activity: DealActivityRow[];
}

export interface Usage {
  plan: string;
  usage: { conversations: number; ai_replies: number; messages_out: number; meta_cost_micros: number };
  included: { conversations: number; aiReplies: number; numbers: number; seats: number };
  percentUsed: number;
  overage: { chats: number; amountIdr: number };
  metaPassThroughIdr: number;
  projectedTotalIdr: number;
  recommendedPlan: string;
}

export interface KnowledgeRow {
  id: string; kind: 'product' | 'faq' | 'policy'; title: string; body: string;
  sku: string | null; price_idr: string | null; stock: number | null; tags: string[]; active: boolean;
}

export interface AutopilotSettings {
  settings: {
    mode: 'off' | 'suggest' | 'auto';
    min_confidence: string;
    may_offer_discount: boolean;
    may_promise_delivery: boolean;
    persona: string;
    max_reply_chars: number;
    max_replies_per_hour: number;
  } | null;
  last30Days: Record<string, number>;
}

export interface WaBridgeChannel {
  id: string;
  displayName: string;
  status: string;
  phoneE164: string | null;
  sessionStatus: string;
  qrDataUrl: string | null;
  qrExpiresAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  maxPerDay: number;
  chatTotal: number;
  chat: {
    meeting: number; minat: number; balas: number; belum: number; tolak: number; bot: number;
  };
}

export interface Contact {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  igUsername: string | null;
  tags: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  address: string | null;
  notes: string | null;
  storeName: string | null;
  storeStatus: 'prospek' | 'aktif' | 'nonaktif' | null;
  scheduleMeeting: string | null;
  clientStatus: 'on_progress' | 'deal';
}

export interface DashboardSummary {
  totalClients: number;
  newClientsThisWeek: number;
  unansweredCount: number;
  salesThisMonthMicros: string;
  salesLastMonthMicros: string;
  avgReplySeconds: number | null;
  daily: { date: string; count: number }[];
  channels: { kind: string; count: number }[];
  pipeline: { stageName: string; isWon: boolean; amountMicros: string }[];
  recentContacts: {
    id: string; displayName: string | null; phone: string | null; tags: string[]; lastSeenAt: string;
  }[];
}

export interface AgentPerformanceSummary {
  activeAgents: number;
  handledToday: number;
  avgReplySeconds: number | null;
  resolutionPct: number | null;
  agents: {
    userId: string; name: string; handled: number; waiting: number;
    avgReplySeconds: number | null; resolved: number;
  }[];
}

export interface IgComment {
  id: string;
  platform: 'instagram' | 'facebook';
  postRef: string;
  commentRef: string;
  /** Set when this is a reply inside another comment's thread. */
  parentRef: string | null;
  commenter: string;
  text: string;
  publicStatus: 'pending' | 'sent' | 'failed' | 'skipped';
  dmStatus: 'pending' | 'sent' | 'failed' | 'skipped';
  publicReply: string | null;
  lastError: string | null;
  conversationId: string | null;
  commentedAt: string | null;
  createdAt: string;
}

export interface ContactDetail {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  igUsername: string | null;
  tags: string[];
  address: string | null;
  notes: string | null;
  storeName: string | null;
  storeStatus: 'prospek' | 'aktif' | 'nonaktif' | null;
  scheduleMeeting: string | null;
  clientStatus: 'on_progress' | 'deal';
}

export interface ContactOrder {
  id: string;
  code: string;
  status: 'draft' | 'awaiting_payment' | 'paid' | 'cancelled' | 'fulfilled';
  totalIdr: number;
  shipArea: string | null;
  createdAt: string;
  lines: { title: string; qty: number }[];
}

export interface ContactTimelineEvent {
  id: string;
  action: string;
  meta: Record<string, unknown>;
  actorType: string;
  actorId: string | null;
  occurredAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string;
  status: 'open' | 'done' | 'cancelled';
  // Free text, not a closed union — a tenant can add its own "Jenis" values
  // (see TaskKind) on top of the four built into the UI.
  kind: string;
  meetingLink: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  repeatUnit: 'day' | 'week' | 'month' | 'year' | null;
  repeatInterval: number;
  repeatUntil: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  brandId: string | null;
  brandName: string | null;
  brandPhone: string | null;
  dealId: string | null;
  dealTitle: string | null;
  assigneeId: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
  // The API already sends this (`GET /v1/tasks` spreads the full row); it was
  // just never typed here. It's the join key for telling a task pill and a
  // Google pill apart when they're the same meeting — a task's own synced
  // event carries this id, and `GoogleCalendarEvent.id` is that same Google
  // event id when Google is asked for it back.
  calendarEventId: string | null;
  calendarEventLink: string | null;
}

/** A custom "Jenis" a tenant added from the task form's "+ Tambah Jenis" option. */
export interface TaskKind {
  id: string;
  name: string;
  createdAt: string;
}

export interface Brand {
  id: string;
  name: string;
  picName: string | null;
  phone: string | null;
  email: string | null;
  instagram: string | null;
  website: string | null;
  category: string | null;
  city: string | null;
  source: 'scrape' | 'manual' | 'referral' | 'other';
  status: 'not_contacted' | 'contacted' | 'replied' | 'interested' | 'rejected';
  assigneeId: string | null;
  notes: string | null;
  contactId: string | null;
  lastContactedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  channel: 'whatsapp' | 'email' | 'other';
  category: 'marketing' | 'utility' | 'authentication';
  language: string;
  body: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IgBridgeConnection {
  /** `awaiting_login` means a browser window is open on the bridge's machine
   * and a person is part-way through Instagram's own login. */
  status: 'disconnected' | 'awaiting_login' | 'challenge_required' | 'ready' | 'error';
  username: string | null;
  challengeType: 'two_factor' | 'checkpoint' | 'unknown' | null;
  lastError: string | null;
  updatedAt: string | null;
  /** False when the bridge service itself could not be reached — a different
   * problem from an expired session, and fixed differently. */
  bridgeReachable?: boolean;
  /** What the last browser login picked up. `sessionid` arrives masked: it is
   * the credential itself and the full value never leaves the bridge. */
  captured?: {
    sessionIdMasked: string;
    csrfToken: string | null;
    dsUserId: string | null;
    capturedAt: string;
  } | null;
}

export interface FbBridgeConnection {
  status: 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';
  pageId: string | null;
  pageName: string | null;
  /** The Business Suite asset id. Null means a personal account, read from
   * messenger.com instead — the two inboxes are different surfaces. */
  assetId: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  updatedAt: string | null;
  /** False when the bridge service itself could not be reached — a different
   * problem from an expired session, and fixed differently. */
  bridgeReachable?: boolean;
}

export interface FacebookComment {
  id: string;
  pageId: string;
  pageName: string | null;
  postId: string;
  commentId: string;
  authorExternalId: string | null;
  authorName: string | null;
  body: string;
  commentedAt: string | null;
  createdAt: string;
}

export interface FbBridgeConnection {
  status: 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';
  pageId: string | null;
  pageName: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  updatedAt: string | null;
  /** False when the bridge service itself could not be reached — a different
   * problem from an expired session, and fixed differently. */
  bridgeReachable?: boolean;
  /** The Business Suite asset id. Null for a personal-inbox connection. */
  assetId: string | null;
}

export type FacebookCommentStatus =
  'new' | 'public_reply_pending' | 'public_replied' | 'dm_pending' | 'dm_sent' | 'failed';

export interface FacebookComment {
  id: string;
  pageId: string;
  pageName: string | null;
  postId: string;
  commentId: string;
  authorExternalId: string | null;
  authorName: string | null;
  body: string;
  commentedAt: string | null;
  createdAt: string;
  /**
   * Where this comment is in the reply-then-DM sequence.
   *
   * The API has always returned these; this type simply did not say so, which
   * left the console unable to show an agent that a public reply had landed
   * even when the private message afterwards had not. The two steps fail
   * independently and are recorded independently.
   */
  status: FacebookCommentStatus;
  publicReplyAt: string | null;
  publicReplyError: string | null;
  dmAt: string | null;
  dmError: string | null;
  attempts: number;
  /** The caption of the post this comment is on, and when that post went up —
   * what the inbox names the post by. Null until the bridge has described it. */
  postText: string | null;
  postCreatedAt: string | null;
}

export interface IgMetaConnection {
  status: 'disconnected' | 'connected' | 'error';
  igUsername: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface EmailSettings {
  configured: boolean;
  emailFrom: string | null;
  updatedAt: string | null;
}

export interface Broadcast {
  id: string;
  name: string;
  templateName: string;
  channelName: string;
  tags: string[];
  total: number;
  sent: number;
  failed: number;
  pending: number;
  createdAt: string;
}

export interface BroadcastRecipient {
  contactId: string;
  contactName: string | null;
  status: string;
  skippedReason: 'no_consent' | 'no_conversation' | null;
}

export interface BroadcastDetail extends Broadcast {
  recipients: BroadcastRecipient[];
}

export interface BroadcastPreview {
  eligible: number;
  noConsent: number;
  noConversation: number;
}

export interface BroadcastChannel {
  id: string;
  displayName: string;
  phoneE164: string | null;
  quality: 'green' | 'yellow' | 'red' | 'flagged';
}

export interface GoogleCalendarEvent {
  id: string; title: string; start: string; end: string; allDay: boolean; htmlLink: string; meetingLink: string | null;
}

export interface GoogleCalendarStatus {
  connected: boolean;
  email: string | null;
}

export interface QuickReply {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesTarget {
  id: string;
  periodStart: string;
  periodEnd: string;
  ownerId: string | null;
  amountIdr: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors `packages/core/src/documentModels/standar.ts` — console can't import
// a server package, and this shape is small/stable enough to repeat here.
export type DocumentMergeField = 'tenant_name' | 'document_name';

// A minimal structural mirror of Tiptap/ProseMirror's JSON document shape —
// kept loose (not importing `@tiptap/core`'s own `JSONContent`) so files that
// don't touch the editor aren't pulled into the Tiptap dependency graph.
export interface RichTextJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextJson[];
  text?: string;
  marks?: { type: string }[];
}

export type DocumentLayoutElement =
  | {
      id: string; type: 'text'; x: number; y: number; w: number; h: number;
      fontSize: number; bold: boolean;
      content: { kind: 'literal'; text: string } | { kind: 'field'; field: DocumentMergeField };
    }
  | { id: string; type: 'richtext'; x: number; y: number; w: number; minHeight: number; content: RichTextJson }
  | { id: string; type: 'image'; x: number; y: number; w: number; h: number; dataUrl: string };

export type DocumentPageSize = 'a4' | 'letter' | 'legal' | 'f4';

// Named `DocRecord`, not `Document` — that name is already the DOM's global type.
export interface DocRecord {
  id: string;
  name: string;
  // Free text, not a closed union — a tenant can add its own "Jenis"/"Model"
  // values (see DocumentKind/DocumentModel) on top of the ones built into the UI.
  kind: string;
  model: string;
  useTemplate: boolean;
  layout: DocumentLayoutElement[] | null;
  pageSize: DocumentPageSize;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A custom "Jenis" a tenant added from the Dokumen form's "+ Tambah Jenis" option. */
export interface DocumentKind {
  id: string;
  name: string;
  createdAt: string;
}

/** A custom "Model" a tenant added from the Dokumen form's "+ Tambah Model" option. */
export interface DocumentModel {
  id: string;
  name: string;
  createdAt: string;
}

export interface ContactPurchaseSummary {
  contactId: string;
  count: number;
  totalIdr: number;
}

export interface Order {
  id: string;
  code: string;
  status: 'draft' | 'awaiting_payment' | 'paid' | 'cancelled' | 'fulfilled';
  contactId: string;
  displayName: string | null;
  phone: string | null;
  itemCount: number;
  totalIdr: number;
  shipArea: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface AuditRow {
  id: number; actor_type: string; actor_id: string | null; action: string;
  resource_type: string; resource_id: string | null; meta: Record<string, unknown>; created_at: string;
}
