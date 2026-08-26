'use client';

import { useActionState, useEffect, useRef } from 'react';
import { inviteMember, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

export function InviteForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(inviteMember, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);

  return (
    <div className="panel">
      <header><h2>{t.team.add}</h2></header>
      <form className="body" action={action} ref={ref}>
        <CsrfField />
        <div className="grid c4" style={{ alignItems: 'end' }}>
          <div className="field">
            <label htmlFor="name">{t.team.addName}</label>
            <input className="input" id="name" name="name" required placeholder="Dimas Arya" />
          </div>
          <div className="field">
            <label htmlFor="email">{t.team.addEmail}</label>
            <input className="input" id="email" name="email" type="email" required placeholder="dimas@tokoanda.id" />
          </div>
          <div className="field">
            <label htmlFor="role">{t.team.addRole}</label>
            <select className="input" id="role" name="role" defaultValue="agent">
              <option value="agent">{t.roles.agent}</option>
              <option value="supervisor">{t.roles.supervisor}</option>
              <option value="admin">{t.roles.admin}</option>
              <option value="viewer">{t.roles.viewer}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="password">{t.team.addPassword}</label>
            <input className="input" id="password" name="password" type="text" required minLength={12}
                   placeholder={t.team.addPasswordHint} />
          </div>
        </div>

        {state?.error ? <p className="error" style={{ marginTop: 12 }}>{state.error}</p> : null}
        {state?.ok ? <p className="ok" style={{ marginTop: 12 }}>{t.team.added}</p> : null}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? t.team.adding : t.team.addSubmit}
          </button>
          <span className="mono dim">{t.team.auditNote}</span>
        </div>
      </form>
    </div>
  );
}
