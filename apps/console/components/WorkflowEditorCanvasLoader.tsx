'use client';

import dynamic from 'next/dynamic';
import type { DummyWorkflow } from '@/lib/dummyWorkflows';

// Konva touches the canvas/DOM at module load — same reasoning as
// DocumentEditorCanvasLoader — so this is the one place `ssr: false` is
// allowed (a Server Component can't pass that option itself).
const WorkflowEditorCanvas = dynamic(
  () => import('@/components/WorkflowEditorCanvas').then((m) => m.WorkflowEditorCanvas),
  { ssr: false },
);

export function WorkflowEditorCanvasLoader({ workflow }: { workflow: DummyWorkflow }) {
  return <WorkflowEditorCanvas workflow={workflow} />;
}
