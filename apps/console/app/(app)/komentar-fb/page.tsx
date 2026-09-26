import { t } from '@/lib/copy';

export default function FbCommentsEmpty() {
  return (
    <div className="thread">
      <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
            <path d="M12.8 15.2V11h1.5l.3-1.8h-1.8V8.1c0-.5.1-.9.8-.9h1V5.6a10 10 0 0 0-1.4-.1c-1.9 0-2.9 1.1-2.9 2.6V9.2H9v1.8h1.3v4.2" />
          </svg>
        </div>
        <h2>{t.chats.pickOne}</h2>
        <p>{t.fbComments.subtitle}</p>
      </div>
    </div>
  );
}
