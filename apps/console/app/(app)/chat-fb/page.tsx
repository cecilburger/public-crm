import { t } from '@/lib/copy';

export default function ChatFbEmpty() {
  return (
    <div className="thread">
      <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <path d="M13.5 20v-6.5h2.2l.4-2.7h-2.6v-1.7c0-.8.2-1.3 1.3-1.3h1.4V5.2c-.6-.1-1.4-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6v2h-2.3v2.7h2.3V20" />
          </svg>
        </div>
        <h2>{t.chats.pickOne}</h2>
        <p>{t.chats.pickOneHelp}</p>
      </div>
    </div>
  );
}
