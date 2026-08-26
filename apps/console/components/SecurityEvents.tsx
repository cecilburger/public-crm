'use client';

import { useActionState } from 'react';
import { acknowledgeSecurityEvent, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { t } from '@/lib/copy';

export interface SecurityEvent {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  notifiable: boolean;
  summary: string;
  detectedAt: string;
  deadline: string | null;
  clock: 'not_applicable' | 'running' | 'due_soon' | 'overdue' | 'notified';
  acknowledgedAt: string | null;
}

const CLOCK_TONE: Record<string, string> = {
  not_applicable: '', running: 'warn', due_soon: 'warn', overdue: 'danger', notified: 'good',
};

function when(iso: string) {
  return new Date(iso).toLocaleString('id-ID', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * The list exists so a person sees the clock before it runs out. Marking one
 * "reported" stops a statutory clock, so it asks for a note about who was told —
 * a record that will matter later far more than the click did.
 */
export function SecurityEvents({ events, clocksRunning }: { events: SecurityEvent[]; clocksRunning: number }) {
  const [state, act, pending] = useActionState<ActionResult | null, FormData>(acknowledgeSecurityEvent, null);

  return (
    <div className="panel">
      <header>
        <h2>{t.security.eventsTitle}</h2>
        {clocksRunning > 0
          ? <span className="chip danger" style={{ marginLeft: 'auto' }}>{t.security.clocksRunning(clocksRunning)}</span>
          : null}
      </header>

      {events.length === 0 ? (
        <p className="empty">{t.security.eventsEmpty}</p>
      ) : (
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="muted" style={{ fontSize: 12.5 }}>{t.security.eventsNote}</p>
          {state?.error ? <p className="error">{state.error}</p> : null}

          {events.map((event) => (
            <article key={event.id} className={`sec-event ${event.severity}`}>
              <div className="sec-head">
                <b>{t.security.kinds[event.kind] ?? event.summary}</b>
                {event.notifiable ? (
                  <span className={`chip ${CLOCK_TONE[event.clock] ?? ''}`}>{t.security.clock[event.clock]}</span>
                ) : null}
                <span className="mono dim" style={{ marginLeft: 'auto' }}>{when(event.detectedAt)}</span>
              </div>

              {event.deadline && event.clock !== 'notified' ? (
                <p className="mono dim">{t.security.deadline}: {when(event.deadline)}</p>
              ) : null}

              {event.clock === 'notified' || event.acknowledgedAt ? null : (
                <form action={act} className="sec-actions">
                  <CsrfField />
                  <input type="hidden" name="id" value={event.id} />
                  {event.notifiable ? (
                    <>
                      <input className="input" name="notes" placeholder={t.security.reportedHint} required />
                      <button className="btn sm" type="submit" name="intent" value="reported" disabled={pending}>
                        {t.security.reported}
                      </button>
                    </>
                  ) : null}
                  <button className="btn ghost sm" type="submit" name="intent" value="ack" disabled={pending}>
                    {t.security.ack}
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
