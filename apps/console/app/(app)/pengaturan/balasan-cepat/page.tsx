import { api, type QuickReply } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { QuickReplyEditor } from '@/components/QuickReplyEditor';

export const dynamic = 'force-dynamic';

export default async function QuickReplyPage() {
  const quickReplies = await api<QuickReply[]>('/v1/quick-replies');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.quickReply.title}</h1>
          <p className="subtitle">{t.quickReply.subtitle}</p>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <QuickReplyEditor quickReplies={quickReplies} />
      </div>
    </>
  );
}
