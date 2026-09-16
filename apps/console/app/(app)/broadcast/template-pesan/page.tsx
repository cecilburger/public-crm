import { api, type MessageTemplate } from '@/lib/api';
import { MessageTemplateTable } from '@/components/MessageTemplateTable';

export const dynamic = 'force-dynamic';

export default async function MessageTemplatePage() {
  const templates = await api<MessageTemplate[]>('/v1/message-templates');

  return (
    <div className="scroll pad odoo-page stack">
      <MessageTemplateTable templates={templates} />
    </div>
  );
}
