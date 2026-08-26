'use client';

import { useActionState } from 'react';
import { markInvoicePaidAction, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';

export interface InvoiceRow {
  id: string;
  number: string;
  status: string;
  totalIdr: number;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
}

const TONE: Record<string, string> = {
  paid: 'good', issued: '', overdue: 'danger', draft: '', void: '', written_off: '',
};

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/**
 * The shop's own bill from Kirana. Collection is a bank transfer today, so the
 * only action is recording the reference off the statement — which is exactly
 * what the first ten customers will need.
 */
export function Invoices({ invoices, outstandingIdr }: { invoices: InvoiceRow[]; outstandingIdr: number }) {
  const [state, act, pending] = useActionState<ActionResult | null, FormData>(markInvoicePaidAction, null);

  return (
    <div className="panel">
      <header>
        <h2>{t.settings.invoices}</h2>
        {outstandingIdr > 0
          ? <span className="chip warn" style={{ marginLeft: 'auto' }}>
              {t.settings.invOutstanding} {rp(outstandingIdr)}
            </span>
          : null}
      </header>

      {invoices.length === 0 ? (
        <p className="empty">{t.settings.invoicesEmpty}</p>
      ) : (
        <>
          {state?.error ? <p className="error" style={{ margin: '12px 14px 0' }}>{state.error}</p> : null}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t.settings.invNumber}</th>
                  <th>{t.settings.invIssued}</th>
                  <th>{t.settings.invDue}</th>
                  <th className="num">{t.settings.invTotal}</th>
                  <th>{t.settings.invStatus}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="mono">{invoice.number}</td>
                    <td>{date(invoice.issuedAt)}</td>
                    <td>{date(invoice.dueAt)}</td>
                    <td className="num">
                      {rp(invoice.totalIdr)}<br />
                      <span className="mono dim">{t.settings.invPpn}</span>
                    </td>
                    <td>
                      <span className={`chip ${TONE[invoice.status] ?? ''}`}>
                        {t.settings.invStatuses[invoice.status] ?? invoice.status}
                      </span>
                    </td>
                    <td>
                      {invoice.status === 'issued' || invoice.status === 'overdue' ? (
                        <form action={act} style={{ display: 'flex', gap: 6 }}>
                          <CsrfField />
                          <input type="hidden" name="id" value={invoice.id} />
                          <input className="input" name="reference" required
                                 placeholder={t.settings.markPaidHint}
                                 style={{ padding: '5px 8px', fontSize: 12.5, maxWidth: 190 }} />
                          <button className="btn sm" type="submit" disabled={pending}>
                            {t.settings.markPaid}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ padding: '10px 14px 14px', fontSize: 12.5 }}>
            {t.settings.invoicesNote}
          </p>
        </>
      )}
    </div>
  );
}
