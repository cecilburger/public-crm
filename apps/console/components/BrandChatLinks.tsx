import { t } from '@/lib/copy';
import { waMeLink } from '@/lib/format';
import type { Brand } from '@/lib/api';

/**
 * A brand is a prospect, not necessarily a CRM contact with a conversation
 * yet — so "chat" opens WhatsApp itself via a `wa.me` link rather than an
 * internal inbox thread.
 */
export function BrandChatLinks({ brand }: { brand: Brand }) {
  if (!brand.phone) return <span className="dim" style={{ fontSize: 11.5 }}>{t.brand.noPhoneForChat}</span>;

  return (
    <a href={waMeLink(brand.phone)} target="_blank" rel="noreferrer" className="icon-link"
       aria-label={t.brand.openChat} title={t.brand.openChat}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />
      </svg>
    </a>
  );
}
