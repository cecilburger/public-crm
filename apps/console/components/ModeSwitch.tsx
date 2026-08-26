'use client';

import { useActionState } from 'react';
import { setAutopilotMode, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

const MODES = [
  { value: 'off', label: t.autopilot.modeOff, note: t.autopilot.modeOffNote },
  { value: 'suggest', label: t.autopilot.modeSuggest, note: t.autopilot.modeSuggestNote },
  { value: 'auto', label: t.autopilot.modeAuto, note: t.autopilot.modeAutoNote },
];

/**
 * Three settings, each with the consequence written next to it. Turning this to
 * "balas sendiri" is the moment a shop lets software talk to its customers
 * unsupervised — it should read like a decision, not a toggle.
 */
export function ModeSwitch({ current }: { current: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(setAutopilotMode, null);

  return (
    <form className="panel" action={action}>
      <header><h2>{t.autopilot.mode}</h2></header>
      <div className="body">
        <CsrfField />
        <div className="modes">
          {MODES.map((mode) => (
            <label key={mode.value} className="mode">
              <input type="radio" name="mode" value={mode.value} defaultChecked={current === mode.value} />
              <span>
                <b>{mode.label}</b>
                <span className="muted">{mode.note}</span>
              </span>
            </label>
          ))}
        </div>
        {state?.error ? <p className="error" style={{ marginTop: 12 }}>{state.error}</p> : null}
        {state?.ok ? <p className="ok" style={{ marginTop: 12 }}>{t.autopilot.saved}</p> : null}
        <button className="btn primary" type="submit" disabled={pending} style={{ marginTop: 14 }}>
          {pending ? t.autopilot.working : t.autopilot.save}
        </button>
      </div>
    </form>
  );
}
