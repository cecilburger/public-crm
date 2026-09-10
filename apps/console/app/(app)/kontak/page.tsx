import { t } from '@/lib/copy';

export default function ContactPage() {
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.contact.title}</h1>
        </div>
      </div>

      <div className="scroll pad stack">
        <div className="panel">
          <p className="empty" style={{ padding: '24px 0' }}>{t.contact.comingSoon}</p>
        </div>
      </div>
    </>
  );
}
