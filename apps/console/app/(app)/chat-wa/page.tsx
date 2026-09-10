import { t } from '@/lib/copy';

export default function ChatWaEmpty() {
  return (
    <div className="thread">
      <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" />
          </svg>
        </div>
        <h2>{t.chats.pickOne}</h2>
        <p>{t.chats.pickOneHelp}</p>
      </div>
    </div>
  );
}
