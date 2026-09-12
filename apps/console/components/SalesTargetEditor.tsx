'use client';

import { useActionState } from 'react';
import { saveSalesTarget, removeSalesTarget, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { SalesTarget, Member } from '@/lib/api';

/**
 * Every row is its own form — same pattern as the message template and quick
 * reply editors. No modal, no separate edit screen, and it works with
 * JavaScript switched off.
 */
export function SalesTargetEditor({ targets, members }: { targets: SalesTarget[]; members: Member[] }) {
  const [saved, save, saving] = useActionState<ActionResult | null, FormData>(saveSalesTarget, null);
  const [, remove] = useActionState<ActionResult | null, FormData>(removeSalesTarget, null);

  const ownerSelect = (defaultValue: string) => (
    <select className="input" name="ownerId" defaultValue={defaultValue}>
      <option value="">{t.target.wholeTeam}</option>
      {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  return (
    <div className="panel">
      <header>
        <h2>{t.target.manage}</h2>
      </header>

      <div className="body stack" style={{ gap: 10 }}>
        {saved?.error ? <p className="error">{saved.error}</p> : null}

        {targets.length === 0 ? (
          <p className="dim" style={{ fontSize: 13 }}>{t.target.empty}</p>
        ) : targets.map((tg) => (
          <form key={tg.id} action={save} className="rowform">
            <CsrfField />
            <input type="hidden" name="id" value={tg.id} />
            <label style={{ maxWidth: 160 }}><span className="mono dim">{t.target.periodStart}</span>
              <input className="input" type="date" name="periodStart" defaultValue={tg.periodStart} required /></label>
            <label style={{ maxWidth: 160 }}><span className="mono dim">{t.target.periodEnd}</span>
              <input className="input" type="date" name="periodEnd" defaultValue={tg.periodEnd} required /></label>
            <label style={{ maxWidth: 180 }}><span className="mono dim">{t.target.owner}</span>
              {ownerSelect(tg.ownerId ?? '')}</label>
            <label style={{ maxWidth: 200 }}><span className="mono dim">{t.target.amount}</span>
              <input className="input" type="number" name="amountIdr" min={1} defaultValue={tg.amountIdr} required /></label>
            <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.target.notes}</span>
              <input className="input" name="notes" defaultValue={tg.notes ?? ''}
                     placeholder={t.target.notesPlaceholder} /></label>
            <button className="btn sm" type="submit" disabled={saving}>{t.target.save}</button>
            <button className="btn ghost sm" type="submit" formAction={remove}>{t.target.remove}</button>
          </form>
        ))}

        <form action={save} className="rowform addrow">
          <CsrfField />
          <label style={{ maxWidth: 160 }}><span className="mono dim">{t.target.periodStart}</span>
            <input className="input" type="date" name="periodStart" required /></label>
          <label style={{ maxWidth: 160 }}><span className="mono dim">{t.target.periodEnd}</span>
            <input className="input" type="date" name="periodEnd" required /></label>
          <label style={{ maxWidth: 180 }}><span className="mono dim">{t.target.owner}</span>
            {ownerSelect('')}</label>
          <label style={{ maxWidth: 200 }}><span className="mono dim">{t.target.amount}</span>
            <input className="input" type="number" name="amountIdr" min={1} placeholder="10000000" required /></label>
          <label style={{ flex: '1 1 100%' }}><span className="mono dim">{t.target.notes}</span>
            <input className="input" name="notes" placeholder={t.target.notesPlaceholder} /></label>
          <button className="btn primary sm" type="submit" disabled={saving}>
            {saving ? t.target.saving : t.target.add}
          </button>
        </form>
      </div>
    </div>
  );
}
