import { api, type MessageTemplate } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { MessageTemplateEditor } from '@/components/MessageTemplateEditor';

export const dynamic = 'force-dynamic';

export default async function MessageTemplatePage() {
  const templates = await api<MessageTemplate[]>('/v1/message-templates');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.messageTemplate.title}</h1>
          <p className="subtitle">{t.messageTemplate.subtitle}</p>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <MessageTemplateEditor templates={templates} />
      </div>
    </>
  );
}
