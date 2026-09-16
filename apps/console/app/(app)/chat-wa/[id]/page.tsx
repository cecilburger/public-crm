import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  api, ApiError, type ConversationDetail, type Member, type Deal, type Me, type QuickReply, type Brand,
  type WaBridgeChannel,
} from '@/lib/api';
import { clock, ago, rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { Composer } from '@/components/Composer';
import { DraftCard } from '@/components/DraftCard';
import { assignConversation, resolveConversation, createDealFromConversation } from '../../actions';
import { CsrfField } from '@/components/Csrf';

export const dynamic = 'force-dynamic';

export default async function ChatWaThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: ConversationDetail;
  try {
    detail = await api<ConversationDetail>(`/v1/conversations/${id}`);
  } catch (err) {
    // The conversation this link pointed to is gone — most likely its WhatsApp
    // number was just deleted, cascading its conversations with it. The list
    // view is still there, so send the agent back to it rather than a dead end.
    if (err instanceof ApiError && err.status === 404) redirect('/chat-wa');
    throw err;
  }

  const [me, members, deals, quickReplies, brands, channels] = await Promise.all([
    api<Me>('/v1/me'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<QuickReply[]>('/v1/quick-replies').catch(() => [] as QuickReply[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    // Multiple WhatsApp Web numbers can be connected at once — this is which
    // one this specific conversation is actually happening on.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
  ]);

  const { conversation, contact, messages, draft } = detail;
  const orders = detail.orders ?? [];
  const assignee = members.find((m) => m.id === conversation.assignee_id);
  const contactDeals = deals.filter((d) => d.contact_id === conversation.contact_id);
  const openValue = contactDeals.filter((d) => d.status === 'open')
    .reduce((sum, d) => sum + Number(d.amount_idr), 0);
  const mine = conversation.assignee_id === me.user.id;
  // If this contact is a known brand's PIC, the deal belongs to that brand —
  // same as everywhere else deals are brand-first; otherwise fall back to
  // the contact so the deal still has somewhere to attach.
  const matchedBrand = brands.find((b) => b.contactId === conversation.contact_id);
  const dealTitle = matchedBrand?.name ?? contact.displayName ?? contact.phone ?? 'Deal Baru';
  const sendingChannel = channels.find((c) => c.id === conversation.channel_id);

  return (
    <div style={{ display: 'flex', minHeight: 0 }}>
      <div className="thread" style={{ flex: 1, minWidth: 0 }}>
        <div className="thread-head">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 15 }}>{contact.displayName ?? contact.phone ?? '—'}</h2>
            {contact.displayName ? <span className="mono dim">{contact.phone ?? '—'}</span> : null}
          </div>

          {/* Which of the (possibly several) connected WhatsApp Web numbers
              this conversation is actually on — so replying never means
              guessing whose name and number the contact sees. */}
          <span className="chip" title={sendingChannel?.phoneE164 ?? undefined}>
            {t.waBridge.chattingFrom}: {sendingChannel
              ? `${sendingChannel.displayName}${sendingChannel.phoneE164 ? ` · ${sendingChannel.phoneE164}` : ''}`
              : t.waBridge.unknownNumber}
          </span>

          {/* A WhatsApp Web session has no 24-hour Meta window — it can always
              reply freely, so the chip and the composer's template branch never
              apply here. */}
          <span className="chip good">{t.chats.canReplyFreely}</span>

          <span className="spacer" style={{ marginLeft: 'auto' }} />

          {!mine ? (
            <form action={assignConversation}>
              <CsrfField />
              <input type="hidden" name="conversationId" value={conversation.id} />
              <input type="hidden" name="assigneeId" value={me.user.id} />
              <button className="btn primary sm" type="submit">{t.chats.takeIt}</button>
            </form>
          ) : null}

          <form action={createDealFromConversation}>
            <CsrfField />
            <input type="hidden" name="conversationId" value={conversation.id} />
            <input type="hidden" name="contactId" value={matchedBrand ? '' : (conversation.contact_id ?? '')} />
            <input type="hidden" name="brandId" value={matchedBrand?.id ?? ''} />
            <input type="hidden" name="title" value={dealTitle} />
            <button className="btn primary sm" type="submit">{t.sales.add}</button>
          </form>

          <details className="dropdown">
            <summary className="btn sm">
              {assignee ? `${t.chats.handledBy}: ${assignee.name}` : t.chats.nobodyYet}
            </summary>
            <form action={assignConversation} className="dropdown-body">
              <CsrfField />
              <input type="hidden" name="conversationId" value={conversation.id} />
              <select className="input" name="assigneeId" defaultValue={conversation.assignee_id ?? ''}
                      aria-label={t.chats.handledBy}>
                <option value="">{t.chats.noOne}</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button className="btn sm" type="submit">{t.chats.assign}</button>
            </form>
          </details>

          {conversation.status !== 'resolved' ? (
            <form action={resolveConversation}>
              <CsrfField />
              <input type="hidden" name="conversationId" value={conversation.id} />
              <button className="btn sm" type="submit">{t.chats.markDone}</button>
            </form>
          ) : <span className="chip good">{t.chats.reopen}</span>}
        </div>

        <div className="thread-body">
          {messages.length === 0 ? <p className="empty">{t.chats.noMessages}</p> : null}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.direction === 'outbound' ? 'out' : ''} ${m.senderType === 'autopilot' ? 'ai' : ''}`}>
              <div className="meta">
                {t.chats.sender[m.senderType] ?? m.senderType} · {clock(m.at)}
              </div>
              <div className="bubble">{m.body ?? <em className="dim">{t.chats.redacted}</em>}</div>
            </div>
          ))}
        </div>

        {draft ? <DraftCard conversationId={conversation.id} draft={draft} /> : null}

        <Composer conversationId={conversation.id} windowOpen customerName={contact.displayName ?? contact.phone ?? '—'}
                  quickReplies={quickReplies} />
      </div>

      <aside className="context" aria-label={t.chats.aboutClient}>
        <section>
          <h3>{t.chats.aboutClient}</h3>
          <div className="kv"><span>{t.chats.name}</span><span className="v">{contact.displayName ?? '—'}</span></div>
          <div className="kv"><span>{t.chats.phone}</span><span className="v">{contact.phone ?? '—'}</span></div>
          <div className="kv"><span>{t.chats.lastChat}</span><span className="v">{ago(conversation.last_inbound_at)}</span></div>
          {contact.tags.length ? (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
              {contact.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
            </div>
          ) : null}
        </section>

        <section>
          <h3>{t.chats.handling}</h3>
          <div className="kv"><span>{t.chats.handledBy}</span><span className="v">{assignee?.name ?? t.chats.noOne}</span></div>
          <div className="kv"><span>{t.chats.status}</span><span className="v">{t.statuses[conversation.status] ?? conversation.status}</span></div>
          <div className="kv"><span>{t.chats.autoReply}</span><span className="v">{conversation.autopilot_mode === 'off' ? 'Mati' : 'Nyala'}</span></div>
        </section>

        <section>
          <h3>{t.chats.ordersHere}</h3>
          {orders.length === 0 ? (
            <p className="dim" style={{ fontSize: 12.5 }}>{t.chats.noOrders}</p>
          ) : orders.map((o) => (
            <div key={o.code} className="kv">
              <span>
                <span className="mono">{o.code}</span><br />
                <span className="chip">{t.chats.orderStatus[o.status] ?? o.status}</span>
              </span>
              <span className="v">{rp(o.totalIdr)}</span>
            </div>
          ))}
        </section>

        <section>
          <h3>{t.chats.salesHere} · {rp(openValue)} {t.chats.inProgress}</h3>
          {contactDeals.length === 0 ? (
            <p className="dim" style={{ fontSize: 12.5 }}>{t.chats.noSales}</p>
          ) : contactDeals.map((d) => (
            <Link key={d.id} href={`/deal/${d.id}`} className="kv">
              <span>{d.brand_name ?? d.title}<br /><span className="mono dim">{d.stage}</span></span>
              <span className="v">{rp(d.amount_idr)}</span>
            </Link>
          ))}
        </section>
      </aside>
    </div>
  );
}
