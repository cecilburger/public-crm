'use client';

import { useState } from 'react';
import Link from '@/components/FastLink';
import { t } from '@/lib/copy';
import { ago } from '@/lib/format';
import { DUMMY_WORKFLOWS, triggerLabel, actionLabels } from '@/lib/dummyWorkflows';

export function WorkflowTable() {
  const [workflows, setWorkflows] = useState(DUMMY_WORKFLOWS);

  const toggleStatus = (id: string) => {
    setWorkflows((prev) => prev.map((w) => (
      w.id === id ? { ...w, status: w.status === 'active' ? 'inactive' : 'active' } : w
    )));
  };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.automation.workflowTitle} <span className="chip warn" style={{ marginLeft: 8 }}>{t.automation.dummyBadge}</span></h1>
            <p className="subtitle">{t.automation.workflowSubtitle}</p>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" disabled title={t.automation.addDisabledHint}>
              {t.automation.add}
            </button>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <table className="odoo-table">
            <thead>
              <tr>
                <th>{t.automation.columnName}</th>
                <th>{t.automation.columnTrigger}</th>
                <th>{t.automation.columnAction}</th>
                <th>{t.automation.columnStatus}</th>
                <th>{t.automation.columnRuns}</th>
                <th>{t.automation.columnLastRun}</th>
                <th style={{ textAlign: 'center' }}>{t.automation.detail}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => {
                const actions = actionLabels(w);
                return (
                  <tr key={w.id}>
                    <td><b>{w.name}</b></td>
                    <td className="dim" style={{ fontSize: 12.5 }}>{triggerLabel(w)}</td>
                    <td className="dim" style={{ fontSize: 12.5 }}>{actions[0]}{actions.length > 1 ? ` +${actions.length - 1}` : ''}</td>
                    <td>
                      <button type="button" className={`chip ${w.status === 'active' ? 'good' : ''}`}
                              style={{ border: 'none', cursor: 'pointer' }}
                              onClick={() => toggleStatus(w.id)} title={t.automation.statusToggleHint}>
                        {w.status === 'active' ? t.automation.statusActive : t.automation.statusInactive}
                      </button>
                    </td>
                    <td className="tnum">{w.runCount}x</td>
                    <td className="dim" suppressHydrationWarning>{ago(w.lastRunAt)}</td>
                    <td style={{ textAlign: 'center' }}>
                      <Link href={`/automation/workflow/${w.id}/editor`} className="btn ghost sm">
                        {t.automation.detail}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
