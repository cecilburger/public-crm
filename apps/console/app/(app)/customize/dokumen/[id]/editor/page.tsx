import { redirect } from 'next/navigation';
import { api, ApiError, type DocRecord } from '@/lib/api';
import { DocumentEditorCanvasLoader } from '@/components/DocumentEditorCanvasLoader';

export const dynamic = 'force-dynamic';

export default async function DocumentEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let doc: DocRecord;
  try {
    doc = await api<DocRecord>(`/v1/documents/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/customize/dokumen');
    throw err;
  }

  // Full-bleed — the canvas needs real screen space, not the centered
  // `record-sheet` card every other Dokumen view uses.
  return (
    <div className="scroll odoo-page stack" style={{ height: '100%' }}>
      <DocumentEditorCanvasLoader doc={doc} />
    </div>
  );
}
