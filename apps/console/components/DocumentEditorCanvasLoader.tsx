'use client';

import dynamic from 'next/dynamic';
import type { DocRecord } from '@/lib/api';

// Konva touches the canvas/DOM at module load — it can't be part of the
// server-rendered HTML, so the actual editor is only ever loaded in the
// browser. This tiny wrapper is the one place that's allowed (`next/dynamic`
// with `ssr: false` is rejected inside a Server Component).
const DocumentEditorCanvas = dynamic(
  () => import('@/components/DocumentEditorCanvas').then((m) => m.DocumentEditorCanvas),
  { ssr: false },
);

export function DocumentEditorCanvasLoader({ doc }: { doc: DocRecord }) {
  return <DocumentEditorCanvas doc={doc} />;
}
