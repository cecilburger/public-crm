'use client';

import { useState } from 'react';
import type { DocRecord, DocumentKind, DocumentModel } from '@/lib/api';
import { t } from '@/lib/copy';
import { DocumentRowActions } from '@/components/DocumentRowActions';
import { DocumentDrawer } from '@/components/DocumentDrawer';
import { DocumentDetailDrawer } from '@/components/DocumentDetailDrawer';

export function DocumentTable({
  documents, documentKinds, documentModels,
}: { documents: DocRecord[]; documentKinds: DocumentKind[]; documentModels: DocumentModel[] }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailDoc, setDetailDoc] = useState<DocRecord | null>(null);

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.document.title}</h1>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" onClick={() => setDrawerOpen(true)}>{t.document.add}</button>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {documents.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>{t.document.empty}</p>
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.document.name}</th>
                  <th>{t.document.kind}</th>
                  <th>{t.document.model}</th>
                  <th>{t.document.useTemplate}</th>
                  <th style={{ textAlign: 'center' }}>{t.document.actions}</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td><b>{doc.name}</b></td>
                    <td><span className="chip">{t.document.kindLabel[doc.kind] ?? doc.kind}</span></td>
                    <td><span className="chip">{t.document.modelLabel[doc.model] ?? doc.model}</span></td>
                    <td>{doc.useTemplate ? t.document.useTemplateYes : t.document.useTemplateNo}</td>
                    <td style={{ textAlign: 'center' }}>
                      <DocumentRowActions doc={doc} onDetail={setDetailDoc} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DocumentDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
                      documentKinds={documentKinds} documentModels={documentModels} />
      <DocumentDetailDrawer doc={detailDoc} open={detailDoc !== null} onClose={() => setDetailDoc(null)}
                            documentKinds={documentKinds} documentModels={documentModels} />
    </>
  );
}
