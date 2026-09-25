import { api, type WaBridgeChannel } from '@/lib/api';
import { t } from '@/lib/copy';
import { isPairing } from '@/lib/format';
import { AutoRefresh } from '@/components/AutoRefresh';
import { WaBridgeConnectButton } from '@/components/WaBridgeConnectButton';
import { WaChannelTable } from '@/components/WaChannelTable';
import { DivisionBadge } from '@/components/DivisionBadge';

export const dynamic = 'force-dynamic';

export default async function ChannelWaPage() {
  const channels = await api<WaBridgeChannel[]>('/v1/wa-bridge/channels');
  // Refreshes fast enough that a rotating QR in the table never goes stale —
  // same reasoning as the Chat WA layout, which this page had been missing.
  const pairing = channels.some((c) => isPairing(c));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.waChannel.title}</h1>
          <p className="subtitle">{t.waChannel.subtitle}</p>
        </div>
        <span className="spacer" />
        <DivisionBadge />
        <AutoRefresh seconds={pairing ? 3 : 10} renderedAt={Date.now()} />
        <WaBridgeConnectButton />
      </div>

      <div className="scroll pad stack">
        <WaChannelTable channels={channels} />
      </div>
    </>
  );
}
