import { api, type WaBridgeChannel } from '@/lib/api';
import { t } from '@/lib/copy';
import { WaBridgeConnectButton } from '@/components/WaBridgeConnectButton';
import { WaChannelTable } from '@/components/WaChannelTable';

export const dynamic = 'force-dynamic';

export default async function ChannelWaPage() {
  const channels = await api<WaBridgeChannel[]>('/v1/wa-bridge/channels');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.waChannel.title}</h1>
          <p className="subtitle">{t.waChannel.subtitle}</p>
        </div>
        <span className="spacer" />
        <WaBridgeConnectButton />
      </div>

      <div className="scroll pad stack">
        <WaChannelTable channels={channels} />
      </div>
    </>
  );
}
