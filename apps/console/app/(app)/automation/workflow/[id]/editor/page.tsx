import { redirect } from 'next/navigation';
import { getDummyWorkflow } from '@/lib/dummyWorkflows';
import { WorkflowEditorCanvasLoader } from '@/components/WorkflowEditorCanvasLoader';

export default async function WorkflowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getDummyWorkflow(id);
  if (!workflow) redirect('/automation/workflow');

  // Full-bleed, same reasoning as the Dokumen editor — the canvas needs real
  // screen space, not the centered card every other page uses.
  return (
    <div className="scroll odoo-page stack" style={{ height: '100%' }}>
      <WorkflowEditorCanvasLoader workflow={workflow} />
    </div>
  );
}
