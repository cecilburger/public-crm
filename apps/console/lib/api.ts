import { redirect } from 'next/navigation';
import { getSession } from './session';

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
}

export async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
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
  const { accessToken } = await getSession();
  if (!accessToken) redirect('/masuk');

  try {
    return await call<T>(path, { ...opts, token: accessToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/masuk?reason=expired');
    throw err;
  }
}

/* ------------------------------------------------------------------ types */

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  workspace: { name: string; slug: string; status: string };
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
    serviceWindowOpen: boolean;
  };
  contact: { displayName: string | null; phone: string | null; tags: string[] };
  draft: AutopilotDraft | null;
  orders: { code: string; status: string; shipArea: string | null; totalIdr: number; createdAt: string }[];
  messages: {
    id: string; direction: 'inbound' | 'outbound';
    senderType: 'contact' | 'agent' | 'autopilot' | 'system';
    /** When the customer sent it, not when we received it. */
    status: string; at: string; body: string | null;
  }[];
}

export interface Member {
  id: string; name: string; email: string; role: Role; status: string; last_login_at: string | null;
}

export interface Deal {
  id: string; title: string; amount_idr: string | number; status: string;
  stage_id: string; stage: string; position: number; rots_at: string | null;
  owner_id: string | null; contact_id: string; contact_name: string | null;
}

export interface Stage {
  id: string; pipeline_id: string; pipeline: string; name: string;
  position: number; is_won: boolean; is_lost: boolean;
}

export interface DealDetail {
  id: string; title: string; amountIdr: number; status: string; lostReason: string | null;
  stageId: string; stageName: string; pipelineId: string; pipelineName: string;
  isWon: boolean; isLost: boolean;
  contactId: string; contactName: string | null; contactPhone: string | null;
  ownerId: string | null; sourceConversationId: string | null;
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
}

export interface Contact {
  id: string;
  displayName: string | null;
  phone: string | null;
  tags: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ContactDetail {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  address: string | null;
  notes: string | null;
}

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string;
  status: 'open' | 'done' | 'cancelled';
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  dealId: string | null;
  dealTitle: string | null;
  assigneeId: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
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
  lastContactedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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
