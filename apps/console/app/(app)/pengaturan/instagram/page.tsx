import { api, type IgBridgeConnection } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { InstagramBridgeForm } from '@/components/InstagramBridgeForm';

export const dynamic = 'force-dynamic';

export default async function InstagramSettingsPage() {
  const connection = await api<IgBridgeConnection>('/v1/instagram-bridge/status');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.instagramBridge.title}</h1>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <InstagramBridgeForm connection={connection} />
      </div>
    </>
  );
}
