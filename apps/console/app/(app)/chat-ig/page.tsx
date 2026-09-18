import { t } from '@/lib/copy';

export default function ChatIgEmpty() {
  return (
    <div className="thread">
      <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="4" /><circle cx="12" cy="12" r="4" /><circle cx="16.5" cy="7.5" r="0.6" fill="currentColor" />
          </svg>
        </div>
        <h2>{t.chats.pickOne}</h2>
        <p>{t.chats.pickOneHelp}</p>
      </div>
    </div>
  );
}
