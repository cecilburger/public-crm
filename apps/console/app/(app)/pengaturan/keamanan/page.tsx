import { api } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { MfaCard } from '@/components/MfaCard';
import { SecurityEvents, type SecurityEvent } from '@/components/SecurityEvents';

export const dynamic = 'force-dynamic';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  backupCodesLeft: number;
  secret?: string;
  uri?: string;
}

export default async function SecurityPage() {
  const [status, events] = await Promise.all([
    api<MfaStatus>('/v1/auth/mfa'),
    // Agents cannot read these; the page still works for them without the card.
    api<{ events: SecurityEvent[]; clocksRunning: number }>('/v1/security/events?limit=50')
      .catch(() => null),
  ]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.security.title}</h1>
          <p className="subtitle">{t.security.subtitle}</p>
        </div>
        {status.enabled
          ? <span className="chip good">{t.security.onNow}</span>
          : <span className="chip warn">{t.security.offNow}</span>}
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <MfaCard status={status} />
        {events ? <SecurityEvents events={events.events} clocksRunning={events.clocksRunning} /> : null}
      </div>
    </>
  );
}
