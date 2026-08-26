import { t } from '@/lib/copy';

export default function ChatsEmpty() {
  return (
    <div className="thread">
      <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />
          </svg>
        </div>
        <h2>{t.chats.pickOne}</h2>
        <p>{t.chats.pickOneHelp}</p>
      </div>
    </div>
  );
}
