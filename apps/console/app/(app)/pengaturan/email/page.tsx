import { api, type EmailSettings } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { EmailSettingsForm } from '@/components/EmailSettingsForm';

export const dynamic = 'force-dynamic';

export default async function EmailSettingsPage() {
  const settings = await api<EmailSettings>('/v1/settings/email');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.emailSettings.title}</h1>
          <p className="subtitle">{t.emailSettings.subtitle}</p>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <EmailSettingsForm settings={settings} />
      </div>
    </>
  );
}
