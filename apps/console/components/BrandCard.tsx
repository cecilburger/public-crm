'use client';

import Link from '@/components/FastLink';
import { setBrandStatus } from '@/app/(app)/actions';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { BrandChatLinks } from '@/components/BrandChatLinks';
import type { Brand, Member } from '@/lib/api';

const STATUSES: Brand['status'][] = ['not_contacted', 'contacted', 'replied', 'interested', 'rejected'];

/** Moving a brand is a dropdown, not a drag — same reasoning as `DealCard`:
 *  works on a phone, works with a keyboard, needs no explaining. */
export function BrandCard({ brand, members }: { brand: Brand; members: Member[] }) {
  const assignee = brand.assigneeId ? members.find((m) => m.id === brand.assigneeId)?.name : null;

  return (
    <article className="deal">
      <Link href={`/brand/${brand.id}`} className="title" style={{ display: 'block' }}>{brand.name}</Link>
      {brand.picName || brand.phone ? (
        <div className="mono dim" style={{ fontSize: 11 }}>
          {[brand.picName, brand.phone].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      {brand.category || brand.city ? (
        <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
          {[brand.category, brand.city].filter(Boolean).join(' · ')}
        </div>
      ) : null}

      <div className="foot" style={{ flexWrap: 'wrap' }}>
        <span className="chip">{t.brand.sourceLabel[brand.source]}</span>
        <span className="chip">{assignee ?? t.brand.unassigned}</span>
        {brand.lastContactedAt ? (
          <span className="mono dim" style={{ fontSize: 11 }}>{ago(brand.lastContactedAt)}</span>
        ) : null}
        <span style={{ marginLeft: 'auto' }}><BrandChatLinks brand={brand} /></span>
      </div>

      <form action={setBrandStatus} style={{ marginTop: 8 }}>
        <CsrfField />
        <input type="hidden" name="id" value={brand.id} />
        <label className="mono dim" htmlFor={`brand-status-${brand.id}`} style={{ display: 'block', marginBottom: 3 }}>
          {t.brand.status}
        </label>
        <select
          className="input" id={`brand-status-${brand.id}`} name="status"
          defaultValue={brand.status}
          style={{ padding: '5px 7px', fontSize: 12.5 }}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{t.brand.statusLabel[s]}</option>)}
        </select>
        <noscript><button className="btn sm" type="submit" style={{ marginTop: 6 }}>{t.brand.status}</button></noscript>
      </form>
    </article>
  );
}
