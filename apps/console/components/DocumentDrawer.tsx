'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createDocument, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { DocumentKindField } from '@/components/DocumentKindField';
import { DocumentModelField } from '@/components/DocumentModelField';
import type { DocumentKind, DocumentModel } from '@/lib/api';

/** A quick-add panel that slides in from the right, same shape as `TaskDrawer`. */
export function DocumentDrawer({
  open, onClose, documentKinds, documentModels,
}: { open: boolean; onClose: () => void; documentKinds: DocumentKind[]; documentModels: DocumentModel[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createDocument, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState('penawaran');
  const [model, setModel] = useState('standar');

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setKind('penawaran');
      setModel('standar');
      onClose();
    }
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.document.newTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.document.newTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.document.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form ref={formRef} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label htmlFor="d-doc-name">{t.document.name}</label>
                <input className="line-input" id="d-doc-name" name="name" required
                       placeholder={t.document.namePlaceholder} />
              </div>

              <DocumentKindField id="d-doc-kind" name="kind" value={kind} onChange={setKind}
                                  initialCustomKinds={documentKinds} />

              <DocumentModelField id="d-doc-model" name="model" value={model} onChange={setModel}
                                   initialCustomModels={documentModels} />

              <div className="record-field">
                <label htmlFor="d-doc-use-template">{t.document.useTemplate}</label>
                <select className="line-input" id="d-doc-use-template" name="useTemplate" defaultValue="ya">
                  <option value="ya">{t.document.useTemplateYes}</option>
                  <option value="tidak">{t.document.useTemplateNo}</option>
                </select>
              </div>
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.document.saving : t.document.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.document.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
