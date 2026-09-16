'use client';

import { useActionState } from 'react';
import { openBrandChat, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand } from '@/lib/api';

/**
 * Opens the internal Chat WA thread for this brand's PIC — resolving (or
 * creating) their Contact and a conversation on the fly if neither exists
 * yet, instead of handing off to an external wa.me link like before.
 */
export function BrandChatLinks({ brand }: { brand: Brand }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(openBrandChat, null);

  if (!brand.phone) return <span className="dim" style={{ fontSize: 11.5 }}>{t.brand.noPhoneForChat}</span>;

  return (
    <form action={formAction} style={{ display: 'inline-block' }}>
      <CsrfField />
      <input type="hidden" name="id" value={brand.id} />
      <button type="submit" className="icon-link" disabled={pending}
              aria-label={t.brand.openChat} title={state?.error ?? t.brand.openChat}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
             strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" />
        </svg>
      </button>
      {state?.error ? <span className="error" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{state.error}</span> : null}
    </form>
  );
}
