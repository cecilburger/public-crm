import { api, type Usage } from '@/lib/api';
import { rp, num } from '@/lib/format';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { Invoices, type InvoiceRow } from '@/components/Invoices';

export const dynamic = 'force-dynamic';

interface PlanRow {
  code: string; label: string; chats: number; priceIdr: number; perChatIdr: number;
  included: { numbers: number; seats: number; aiReplies: number };
  extras: { numberIdr: number; seatIdr: number; aiPackIdr: number };
  overagePerChatIdr: number;
}

export default async function BillingPage() {
  const [usage, plans, invoices] = await Promise.all([
    api<Usage>('/v1/usage'),
    api<{ plans: PlanRow[] }>('/v1/billing/plans'),
    // Only the owner may see these; the page still works for everyone else.
    api<{ invoices: InvoiceRow[]; outstandingIdr: number }>('/v1/invoices').catch(() => null),
  ]);

  const pct = Math.min(100, usage.percentUsed);
  const tone = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : '';
  const aiPct = Math.min(100, Math.round((usage.usage.ai_replies / Math.max(1, usage.included.aiReplies)) * 100));

  // The API returns the cheapest plan for the volume so far. Early in a month
  // that is always the smallest one, which is noise — only show the suggestion
  // when it genuinely means "you are paying extra and a bigger plan is cheaper".
  const RANK = ['starter', 'growth', 'scale', 'custom'];
  const suggestUpgrade = RANK.indexOf(usage.recommendedPlan) > RANK.indexOf(usage.plan);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.settings.title}</h1>
          <p className="subtitle">{t.settings.usageSubtitle}</p>
        </div>
        <span className="chip brand">{usage.plan}</span>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        {suggestUpgrade ? (
          <div className="notice">
            <span className="notice-icon" aria-hidden>!</span>
            <span>
              <strong>{t.settings.upgradeTitle}</strong><br />
              {t.settings.upgradeBody(usage.recommendedPlan, rp(usage.overage.amountIdr))}
            </span>
          </div>
        ) : null}

        <div className="grid c4">
          <div className="panel"><div className="body">
            <div className="mono dim upper">{t.settings.chats}</div>
            <div className="bignum" style={{ marginTop: 6 }}>{num(usage.usage.conversations)}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {t.settings.ofIncluded} {num(usage.included.conversations)} {t.settings.included}
            </div>
            <div className={`meter ${tone}`} style={{ marginTop: 10 }}><span style={{ width: `${pct}%` }} /></div>
          </div></div>

          <div className="panel"><div className="body">
            <div className="mono dim upper">{t.settings.autoReplies}</div>
            <div className="bignum" style={{ marginTop: 6 }}>{num(usage.usage.ai_replies)}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {t.settings.ofIncluded} {num(usage.included.aiReplies)} {t.settings.included}
            </div>
            <div className="meter" style={{ marginTop: 10 }}><span style={{ width: `${aiPct}%` }} /></div>
          </div></div>

          <div className="panel"><div className="body">
            <div className="mono dim upper">{t.settings.extra}</div>
            <div className="bignum" style={{ marginTop: 6 }}>{rp(usage.overage.amountIdr)}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {usage.overage.chats > 0
                ? `${num(usage.overage.chats)} ${t.settings.beyondPlan}`
                : t.settings.insidePlan}
            </div>
          </div></div>

          <div className="panel"><div className="body">
            <div className="mono dim upper">{t.settings.estimate}</div>
            <div className="bignum" style={{ marginTop: 6 }}>{rp(usage.projectedTotalIdr)}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t.settings.exVat}</div>
          </div></div>
        </div>

        {invoices ? <Invoices invoices={invoices.invoices} outstandingIdr={invoices.outstandingIdr} /> : null}

        <div className="panel">
          <header><h2>{t.settings.thisMonth}</h2></header>
          <table>
            <thead>
              <tr><th>{t.settings.line}</th><th className="num">{t.settings.qty}</th><th className="num">{t.settings.amount}</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><b>{t.settings.planLine} {usage.plan}</b><br />
                    <span className="mono dim">{num(usage.included.conversations)} {t.settings.chats.toLowerCase()}</span></td>
                <td className="num">1</td>
                <td className="num">{rp(usage.projectedTotalIdr - usage.overage.amountIdr)}</td>
              </tr>
              {usage.overage.chats > 0 ? (
                <tr>
                  <td><b>{t.settings.extraLine}</b></td>
                  <td className="num">{num(usage.overage.chats)}</td>
                  <td className="num">{rp(usage.overage.amountIdr)}</td>
                </tr>
              ) : null}
              <tr>
                <td><b>{t.settings.metaLine}</b><br /><span className="mono dim">{t.settings.metaNote}</span></td>
                <td className="num">—</td>
                <td className="num">{rp(usage.metaPassThroughIdr)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel">
          <header><h2>{t.settings.countedHow}</h2></header>
          <div className="body">
            <p className="muted" style={{ maxWidth: '62ch', lineHeight: 1.6 }}>{t.settings.countedHowBody}</p>
          </div>
        </div>

        <div className="panel">
          <header>
            <h2>{t.settings.plans}</h2>
            <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.settings.plansNote}</span>
          </header>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t.settings.plan}</th><th className="num">{t.settings.chats}</th>
                  <th className="num">{t.settings.perMonth}</th><th className="num">{t.settings.perChat}</th>
                  <th className="num">{t.settings.numbers}</th><th className="num">{t.settings.seats}</th>
                  <th className="num">{t.settings.extraPerChat}</th>
                </tr>
              </thead>
              <tbody>
                {plans.plans.map((p) => (
                  <tr key={p.code} style={p.code === usage.plan ? { background: 'var(--brand-soft)' } : undefined}>
                    <td>
                      <b>{p.label}</b>
                      {p.code === usage.plan ? <span className="chip brand" style={{ marginLeft: 8 }}>{t.settings.current}</span> : null}
                      {suggestUpgrade && p.code === usage.recommendedPlan
                        ? <span className="chip accent" style={{ marginLeft: 8 }}>{t.settings.suggested}</span> : null}
                    </td>
                    <td className="num">{num(p.chats)}</td>
                    <td className="num">{rp(p.priceIdr)}</td>
                    <td className="num">{rp(p.perChatIdr)}</td>
                    <td className="num">{p.included.numbers}</td>
                    <td className="num">{p.included.seats}</td>
                    <td className="num">{rp(p.overagePerChatIdr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
