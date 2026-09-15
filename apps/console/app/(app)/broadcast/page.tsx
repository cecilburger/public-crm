import { api, type Broadcast, type BroadcastChannel, type MessageTemplate } from '@/lib/api';
import { BroadcastTable } from '@/components/BroadcastTable';

export const dynamic = 'force-dynamic';

export default async function BroadcastPage() {
  const [broadcasts, channels, templates] = await Promise.all([
    api<Broadcast[]>('/v1/broadcasts'),
    api<BroadcastChannel[]>('/v1/broadcasts/channels').catch(() => [] as BroadcastChannel[]),
    api<MessageTemplate[]>('/v1/message-templates').catch(() => [] as MessageTemplate[]),
  ]);

  const approvedTemplates = templates.filter((tpl) => tpl.status === 'approved');

  return (
    <div className="scroll pad odoo-page stack">
      <BroadcastTable broadcasts={broadcasts} channels={channels} templates={approvedTemplates} />
    </div>
  );
}
