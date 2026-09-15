'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Stage, Layer, Group, Rect, Text as KonvaText, Line, Circle } from 'react-konva';
import Konva from 'konva';
import { t } from '@/lib/copy';
import { KIND_ICON_PATHS } from '@/components/KindIcon';
import {
  NODE_W, NODE_H, HEADER_H, type DummyWorkflow, type WorkflowNode, type WorkflowNodeKind,
} from '@/lib/dummyWorkflows';

const STAGE_W = 900;
const KIND_COLOR: Record<WorkflowNodeKind, string> = { trigger: '#2F31A8', condition: '#B4530C', action: '#0E7A64' };
const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  trigger: t.automation.stepTrigger, condition: t.automation.stepConditions, action: t.automation.stepActions,
};

const PICKER_ICON: Record<string, React.ReactNode> = {
  chat: KIND_ICON_PATHS.chat, meeting: KIND_ICON_PATHS.meeting,
  bell: <><path d="M12 3a5 5 0 0 0-5 5v3.3L5 15h14l-2-3.7V8a5 5 0 0 0-5-5Z" /><path d="M9.5 18a2.5 2.5 0 0 0 5 0" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.3 2" /></>,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z" />,
  tag: <><path d="M20 12.5 12.5 20a1.5 1.5 0 0 1-2.1 0L4 13.6a1.5 1.5 0 0 1 0-2.1L11.5 4H18a2 2 0 0 1 2 2v6.5Z" /><circle cx="14" cy="9" r="1.3" fill="currentColor" stroke="none" /></>,
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
};

interface Preset { kind: 'action' | 'condition'; title: string; label: string; icon: keyof typeof PICKER_ICON }

const ACTION_PRESETS: Preset[] = [
  { kind: 'action', title: 'Kirim WhatsApp', label: 'Kirim pesan WhatsApp ke kontak', icon: 'chat' },
  { kind: 'action', title: 'Buat Tugas', label: 'Buat tugas baru dan tetapkan ke agen', icon: 'meeting' },
  { kind: 'action', title: 'Update Status', label: 'Ubah status deal atau pesanan', icon: 'tag' },
  { kind: 'action', title: 'Kirim Notifikasi', label: 'Kirim notifikasi ke tim', icon: 'bell' },
  { kind: 'action', title: 'Tunggu', label: 'Tunggu beberapa saat sebelum lanjut', icon: 'clock' },
  { kind: 'action', title: 'Aksi Kustom', label: 'Tulis aksi Anda sendiri', icon: 'edit' },
];
const CONDITION_PRESETS: Preset[] = [
  { kind: 'condition', title: 'Cek Status', label: 'Jika status memenuhi kondisi tertentu', icon: 'filter' },
  { kind: 'condition', title: 'Cek Tag', label: 'Jika kontak atau deal punya tag tertentu', icon: 'tag' },
  { kind: 'condition', title: 'Kondisi Kustom', label: 'Tulis kondisi Anda sendiri', icon: 'edit' },
];

function PickerIcon({ icon, color }: { icon: keyof typeof PICKER_ICON; color: string }) {
  return (
    <span className="wf-picker-icon" style={{ background: color }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {PICKER_ICON[icon]}
      </svg>
    </span>
  );
}

function NodeCard({
  node, isSelected, onSelect, onDrag,
}: { node: WorkflowNode; isSelected: boolean; onSelect: () => void; onDrag: (x: number, y: number) => void }) {
  const color = KIND_COLOR[node.kind];
  return (
    <Group
      x={node.x} y={node.y} draggable
      onClick={onSelect} onTap={onSelect}
      onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => onDrag(e.target.x(), e.target.y())}
    >
      <Rect width={NODE_W} height={NODE_H} cornerRadius={10} fill="#FFFFFF"
            stroke={isSelected ? color : '#E0DFEC'} strokeWidth={isSelected ? 2.5 : 1}
            shadowColor="black" shadowOpacity={0.14} shadowBlur={8} shadowOffsetY={2} />
      <Rect width={NODE_W} height={HEADER_H} cornerRadius={[10, 10, 0, 0]} fill={color} />
      <KonvaText text={node.title} x={12} y={7} width={NODE_W - 24} height={HEADER_H - 10}
                 fontSize={12} fontStyle="600" fill="#FFFFFF" ellipsis wrap="none" listening={false} />
      <KonvaText text={node.label} x={12} y={HEADER_H + 8} width={NODE_W - 24} height={NODE_H - HEADER_H - 14}
                 fontSize={11.5} fill="#16183C" wrap="word" ellipsis listening={false} />
    </Group>
  );
}

function Connector({ from, to, onInsert }: { from: WorkflowNode; to: WorkflowNode; onInsert: () => void }) {
  const x1 = from.x + NODE_W / 2; const y1 = from.y + NODE_H;
  const x2 = to.x + NODE_W / 2; const y2 = to.y;
  const midX = (x1 + x2) / 2; const midY = (y1 + y2) / 2;
  return (
    <>
      <Line points={[x1, y1, x2, y2]} stroke="#C9C7DD" strokeWidth={2} />
      <Group x={midX} y={midY} onClick={onInsert} onTap={onInsert}>
        <Circle radius={11} fill="#FFFFFF" stroke="#8A8DAC" strokeWidth={1.5} />
        <KonvaText text="+" x={-4} y={-8} fontSize={16} fill="#565A80" listening={false} />
      </Group>
    </>
  );
}

type Panel = { mode: 'insert'; afterIndex: number } | { mode: 'edit'; nodeId: string } | null;

/**
 * Interactive node canvas for one workflow — Konva, the same library the
 * Dokumen layout editor uses. Nodes are a single top-to-bottom chain (the
 * shape most workflow-builder UIs use — HubSpot, n8n, Zapier): every "+" on
 * a connector splices a new step in at that exact gap, so a node can never
 * end up pointing at a connection that doesn't make sense.
 */
export function WorkflowEditorCanvas({ workflow }: { workflow: DummyWorkflow }) {
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow.nodes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [saved, setSaved] = useState(false);
  const [scale, setScale] = useState(1);
  const [query, setQuery] = useState('');

  const stageH = Math.max(520, nodes.length * (NODE_H + 72) + 160);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const editingNode = panel?.mode === 'edit' ? nodes.find((n) => n.id === panel.nodeId) ?? null : null;

  const updateNode = (id: string, patch: Partial<WorkflowNode>) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    setSaved(false);
  };

  const removeNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setSelectedId(null);
    setPanel(null);
    setSaved(false);
  };

  const insertPreset = (preset: Preset) => {
    if (panel?.mode !== 'insert') return;
    const after = nodes[panel.afterIndex];
    const next = nodes[panel.afterIndex + 1];
    const id = `${workflow.id}-ins-${Date.now()}`;
    const y = next ? (after.y + next.y) / 2 : after.y + NODE_H + 72;
    const newNode: WorkflowNode = { id, kind: preset.kind, title: preset.title, label: preset.label, x: after.x, y };
    setNodes((prev) => {
      const copy = [...prev];
      copy.splice(panel.afterIndex + 1, 0, newNode);
      return copy;
    });
    setPanel(null);
    setSelectedId(id);
    setSaved(false);
  };

  const edges = useMemo(() => nodes.slice(0, -1).map((n, i) => [n, nodes[i + 1]] as const), [nodes]);
  const lastNode = nodes[nodes.length - 1];
  const filteredPresets = (panel?.mode === 'insert' ? [...ACTION_PRESETS, ...CONDITION_PRESETS] : [])
    .filter((p) => p.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="doc-editor-toolbar">
        <Link href="/automation/workflow" className="btn ghost sm">{t.automation.backToList}</Link>
        <h2 style={{ fontSize: 14 }}>{workflow.name}</h2>
        <span className="chip warn">{t.automation.dummyBadge}</span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn primary sm" onClick={() => setSaved(true)}>{t.automation.save}</button>
        {saved ? <span className="chip good">{t.automation.editorSaved}</span> : null}
      </div>

      <div className="doc-editor-body" style={{ position: 'relative' }}>
        <div className="wf-editor-stage-wrap" style={{ position: 'relative' }}>
          <Stage width={STAGE_W} height={stageH} scaleX={scale} scaleY={scale}
                 onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelectedId(null); }}>
            <Layer>
              {edges.map(([from, to], i) => (
                <Connector key={`${from.id}-${to.id}`} from={from} to={to} onInsert={() => setPanel({ mode: 'insert', afterIndex: i })} />
              ))}
              {lastNode ? (
                <>
                  <Line points={[lastNode.x + NODE_W / 2, lastNode.y + NODE_H, lastNode.x + NODE_W / 2, lastNode.y + NODE_H + 40]}
                        stroke="#C9C7DD" strokeWidth={2} />
                  <Group x={lastNode.x + NODE_W / 2} y={lastNode.y + NODE_H + 40}
                         onClick={() => setPanel({ mode: 'insert', afterIndex: nodes.length - 1 })}>
                    <Circle radius={11} fill="#FFFFFF" stroke="#8A8DAC" strokeWidth={1.5} />
                    <KonvaText text="+" x={-4} y={-8} fontSize={16} fill="#565A80" listening={false} />
                  </Group>
                </>
              ) : null}
              {nodes.map((n) => (
                <NodeCard key={n.id} node={n} isSelected={n.id === selectedId}
                          onSelect={() => { setSelectedId(n.id); setPanel({ mode: 'edit', nodeId: n.id }); }}
                          onDrag={(x, y) => updateNode(n.id, { x, y })} />
              ))}
            </Layer>
          </Stage>

          <div className="wf-zoom">
            <button type="button" onClick={() => setScale((s) => Math.min(1.5, s + 0.1))}>+</button>
            <button type="button" onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}>−</button>
            <span className="tnum">{Math.round(scale * 100)}%</span>
          </div>
        </div>
      </div>

      {/* Slide-in panel — "insert" picks a preset to splice in at a connector's
          "+"; "edit" shows the clicked node's own fields. Same shell, two modes,
          so there's one place that owns the open/close transition. */}
      <div className={`drawer-backdrop ${panel ? 'open' : ''}`} onClick={() => setPanel(null)} aria-hidden="true" />
      <div className={`drawer-panel ${panel ? 'open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!panel}>
        {panel?.mode === 'insert' ? (
          <>
            <div className="drawer-head">
              <h2>{t.automation.chooseAction}</h2>
              <button type="button" className="drawer-close" onClick={() => setPanel(null)} aria-label={t.tasks.close}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="drawer-body">
              <input className="line-input wf-picker-search" placeholder={t.automation.searchActions}
                     value={query} onChange={(e) => setQuery(e.target.value)} />
              <p className="wf-picker-section">{t.automation.stepActions}</p>
              {filteredPresets.filter((p) => p.kind === 'action').map((p) => (
                <button key={p.title} type="button" className="wf-picker-item" onClick={() => insertPreset(p)}>
                  <PickerIcon icon={p.icon} color={KIND_COLOR.action} />
                  <span>
                    <b>{p.title}</b>
                    <span className="dim" style={{ display: 'block', fontSize: 11.5 }}>{p.label}</span>
                  </span>
                </button>
              ))}
              <p className="wf-picker-section">{t.automation.stepConditions}</p>
              {filteredPresets.filter((p) => p.kind === 'condition').map((p) => (
                <button key={p.title} type="button" className="wf-picker-item" onClick={() => insertPreset(p)}>
                  <PickerIcon icon={p.icon} color={KIND_COLOR.condition} />
                  <span>
                    <b>{p.title}</b>
                    <span className="dim" style={{ display: 'block', fontSize: 11.5 }}>{p.label}</span>
                  </span>
                </button>
              ))}
              {filteredPresets.length === 0 ? <p className="dim" style={{ fontSize: 12.5 }}>{t.automation.noActionsFound}</p> : null}
            </div>
          </>
        ) : editingNode ? (
          <>
            <div className="drawer-head">
              <h2>{KIND_LABEL[editingNode.kind]}</h2>
              <button type="button" className="drawer-close" onClick={() => setPanel(null)} aria-label={t.tasks.close}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="drawer-body">
              <div className="record-field">
                <label>{t.automation.nodeTitleField}</label>
                <input className="line-input" value={editingNode.title}
                       onChange={(e) => updateNode(editingNode.id, { title: e.target.value })} />
              </div>
              <div className="record-field">
                <label>{t.automation.nodeLabelField}</label>
                <textarea className="line-input" rows={3} value={editingNode.label}
                          onChange={(e) => updateNode(editingNode.id, { label: e.target.value })} />
              </div>
              {editingNode.kind === 'trigger' ? (
                <p className="dim" style={{ fontSize: 11.5 }}>{t.automation.cannotRemoveTrigger}</p>
              ) : (
                <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                        onClick={() => removeNode(editingNode.id)}>
                  {t.automation.removeNode}
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
