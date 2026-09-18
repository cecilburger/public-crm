import { api, type IgBridgeConnection, type IgMetaConnection } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { InstagramBridgeForm } from '@/components/InstagramBridgeForm';
import { InstagramMetaCard } from '@/components/InstagramMetaCard';

export const dynamic = 'force-dynamic';

export default async function InstagramSettingsPage() {
  const [bridgeConnection, metaConnection] = await Promise.all([
    api<IgBridgeConnection>('/v1/instagram-bridge/status'),
    api<IgMetaConnection>('/v1/instagram-meta/status'),
  ]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.instagramBridge.title}</h1>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <InstagramMetaCard connection={metaConnection} />
        <InstagramBridgeForm connection={bridgeConnection} />
      </div>
    </>
  );
}
