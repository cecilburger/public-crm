import { api, type IgBridgeConnection, type IgMetaConnection } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { InstagramBridgeForm } from '@/components/InstagramBridgeForm';
import { InstagramMetaCard } from '@/components/InstagramMetaCard';
import { DivisionBadge } from '@/components/DivisionBadge';

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
        <span className="spacer" />
        <DivisionBadge />
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <InstagramBridgeForm connection={bridgeConnection} />
        {/* The Graph API card is hidden unless it is actually in use. Its form
            asks for a hand-made access token from the Meta App dashboard, which
            is not how this workspace connects Instagram — leaving it on screen
            only offered a second, unused way in beside the one that works.
            Still rendered while connected, so an existing connection stays
            visible and can be disconnected rather than becoming invisible. */}
        {metaConnection.status === 'connected' ? (
          <InstagramMetaCard connection={metaConnection} />
        ) : null}
      </div>
    </>
  );
}
