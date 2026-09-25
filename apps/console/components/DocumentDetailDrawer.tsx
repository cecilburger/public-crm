'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from '@/components/FastLink';
import { updateDocument, deleteDocument, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { DocumentKindField } from '@/components/DocumentKindField';
import { DocumentModelField } from '@/components/DocumentModelField';
import type { DocRecord, DocumentKind, DocumentModel } from '@/lib/api';
import { withBase } from '@/lib/basePath';

/** Opens on a document's "Detail" action — same slide-in shell as
 *  `DocumentDrawer`, pre-filled and saving through `updateDocument`. */
export function DocumentDetailDrawer({
  doc: incoming, open, onClose, documentKinds, documentModels,
}: {
  doc: DocRecord | null; open: boolean; onClose: () => void;
  documentKinds: DocumentKind[]; documentModels: DocumentModel[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateDocument, null);
  // The caller clears `doc` to null the moment it closes the drawer, so the
  // panel would otherwise vanish instantly instead of sliding out — this
  // keeps rendering the last document while `open` drives the CSS transition.
  const [doc, setDoc] = useState<DocRecord | null>(incoming);
  const [kind, setKind] = useState(incoming?.kind ?? 'penawaran');
  const [model, setModel] = useState(incoming?.model ?? 'standar');
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (incoming) { setDoc(incoming); setKind(incoming.kind); setModel(incoming.model); }
  }, [incoming]);

  useEffect(() => {
    if (state?.ok) onClose();
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!doc) return null;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.document.detailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.document.detailTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.document.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form key={doc.id} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <input type="hidden" name="id" value={doc.id} />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label htmlFor="e-doc-name">{t.document.name}</label>
                <input className="line-input" id="e-doc-name" name="name" required
                       defaultValue={doc.name} placeholder={t.document.namePlaceholder} />
              </div>

              <DocumentKindField id="e-doc-kind" name="kind" value={kind} onChange={setKind}
                                  initialCustomKinds={documentKinds} />

              <DocumentModelField id="e-doc-model" name="model" value={model} onChange={setModel}
                                   initialCustomModels={documentModels} />

              <div className="record-field">
                <label htmlFor="e-doc-use-template">{t.document.useTemplate}</label>
                <select className="line-input" id="e-doc-use-template" name="useTemplate"
                        defaultValue={doc.useTemplate ? 'ya' : 'tidak'}>
                  <option value="ya">{t.document.useTemplateYes}</option>
                  <option value="tidak">{t.document.useTemplateNo}</option>
                </select>
              </div>

              <div className="record-field">
                <span style={{ display: 'flex', gap: 8 }}>
                  <a href={withBase(`/api/dokumen/${doc.id}/generate`)} target="_blank" rel="noreferrer" className="btn ghost sm">
                    {t.document.generate}
                  </a>
                  <Link href={`/customize/dokumen/${doc.id}/editor`} className="btn ghost sm">
                    {t.document.editLayout}
                  </Link>
                </span>
              </div>
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.document.saving : t.document.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.document.discard}</button>
            <button type="button" className="btn ghost" style={{ marginLeft: 'auto', color: 'var(--danger)' }}
                    onClick={() => deleteDialogRef.current?.showModal()}>
              {t.document.delete}
            </button>
          </div>
        </form>
      </div>

      <dialog ref={deleteDialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.document.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => deleteDialogRef.current?.close()}>
            {t.document.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.document.deleteWarning(doc.name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => deleteDialogRef.current?.close()}>
              {t.document.discard}
            </button>
            <form action={deleteDocument}>
              <CsrfField />
              <input type="hidden" name="id" value={doc.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.document.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
