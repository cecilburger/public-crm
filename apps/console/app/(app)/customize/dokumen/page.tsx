import { api, type DocRecord, type DocumentKind, type DocumentModel } from '@/lib/api';
import { DocumentTable } from '@/components/DocumentTable';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const [documents, documentKinds, documentModels] = await Promise.all([
    api<DocRecord[]>('/v1/documents'),
    api<DocumentKind[]>('/v1/document-kinds').catch(() => [] as DocumentKind[]),
    api<DocumentModel[]>('/v1/document-models').catch(() => [] as DocumentModel[]),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      <DocumentTable documents={documents} documentKinds={documentKinds} documentModels={documentModels} />
    </div>
  );
}
