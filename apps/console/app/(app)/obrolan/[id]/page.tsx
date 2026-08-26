import { notFound } from 'next/navigation';
import { api, ApiError, type ConversationDetail, type Member, type Deal, type Me } from '@/lib/api';
import { clock, ago, rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { Composer } from '@/components/Composer';
import { DraftCard } from '@/components/DraftCard';
import { assignConversation, resolveConversation } from '../../actions';
import { CsrfField } from '@/components/Csrf';

export const dynamic = 'force-dynamic';

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: ConversationDetail;
  try {
    detail = await api<ConversationDetail>(`/v1/conversations/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const [me, members, deals] = await Promise.all([
    api<Me>('/v1/me'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
  ]);

  const { conversation, contact, messages, draft } = detail;
  // Tolerate an older API that does not send this yet — a missing panel beats a
  // 500 on the page an agent lives in.
  const orders = detail.orders ?? [];
  const assignee = members.find((m) => m.id === conversation.assignee_id);
  const contactDeals = deals.filter((d) => d.contact_id === conversation.contact_id);
  const openValue = contactDeals.filter((d) => d.status === 'open')
    .reduce((sum, d) => sum + Number(d.amount_idr), 0);
  const mine = conversation.assignee_id === me.user.id;

  return (
    <div style={{ display: 'flex', minHeight: 0 }}>
      <div className="thread" style={{ flex: 1, minWidth: 0 }}>
        <div className="thread-head">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 15 }}>{contact.displayName ?? t.chats.unknown}</h2>
            <span className="mono dim">{contact.phone ?? '—'}</span>
          </div>

          {conversation.serviceWindowOpen
            ? <span className="chip good">{t.chats.canReplyFreely}</span>
            : <span className="chip warn">{t.chats.templateOnly}</span>}

          <span className="spacer" style={{ marginLeft: 'auto' }} />

          {/* One obvious button for the common case, the full picker for the rest. */}
          {!mine ? (
            <form action={assignConversation}>
              <CsrfField />
              <input type="hidden" name="conversationId" value={conversation.id} />
              <input type="hidden" name="assigneeId" value={me.user.id} />
              <button className="btn primary sm" type="submit">{t.chats.takeIt}</button>
            </form>
          ) : null}

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

        <Composer conversationId={conversation.id} windowOpen={conversation.serviceWindowOpen}
                  customerName={contact.displayName ?? t.chats.unknown} />
      </div>

      <aside className="context" aria-label={t.chats.aboutCustomer}>
        <section>
          <h3>{t.chats.aboutCustomer}</h3>
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
            <div key={d.id} className="kv">
              <span>{d.title}<br /><span className="mono dim">{d.stage}</span></span>
              <span className="v">{rp(d.amount_idr)}</span>
            </div>
          ))}
        </section>

        <section>
          <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{t.chats.billingNote}</p>
        </section>
      </aside>
    </div>
  );
}
