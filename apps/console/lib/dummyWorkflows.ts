/**
 * Placeholder data for the Automation → Workflow feature — no backend exists
 * yet, so this is the one shared source both the list page and the editor
 * page read from. A fixed anchor (not Date.now()) for `lastRunAt`: the SSR
 * pass and the client hydration pass run this module a beat apart, and
 * anything computed from the live clock would render a different string
 * each time and break hydration.
 */
const DEMO_NOW = new Date('2026-09-14T15:00:00+07:00').getTime();
const hoursAgo = (h: number) => new Date(DEMO_NOW - h * 3600_000).toISOString();

export type WorkflowNodeKind = 'trigger' | 'condition' | 'action';

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Short header label, shown in the node's colored title bar — e.g. "Kirim WhatsApp". */
  title: string;
  /** Longer description, shown in the node's white body — e.g. "Kirim template 'Selamat Datang' ke kontak". */
  label: string;
  x: number;
  y: number;
}

export interface DummyWorkflow {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  runCount: number;
  lastRunAt: string;
  /** Canonical top-to-bottom chain order — position on the canvas is just a
   *  starting point (nodes are freely draggable), the connections themselves
   *  always follow this array order. */
  nodes: WorkflowNode[];
}

export const triggerLabel = (wf: DummyWorkflow): string => wf.nodes.find((n) => n.kind === 'trigger')?.label ?? '';
export const actionLabels = (wf: DummyWorkflow): string[] => wf.nodes.filter((n) => n.kind === 'action').map((n) => n.label);

export const NODE_W = 230;
export const NODE_H = 78;
export const HEADER_H = 28;
const GAP_Y = 72;
const TOP_PAD = 30;
export const CANVAS_W = 520;

type Entry = { kind: WorkflowNodeKind; title: string; label: string };

function layout(id: string, entries: Entry[]): WorkflowNode[] {
  const x = CANVAS_W / 2 - NODE_W / 2;
  return entries.map((e, i) => ({ id: `${id}-n${i}`, kind: e.kind, title: e.title, label: e.label, x, y: TOP_PAD + i * (NODE_H + GAP_Y) }));
}

export const DUMMY_WORKFLOWS: DummyWorkflow[] = [
  {
    id: 'wf-1', name: 'Sambut Kontak Baru', status: 'active', runCount: 156, lastRunAt: hoursAgo(0.15),
    nodes: layout('wf-1', [
      { kind: 'trigger', title: 'Kontak Baru Ditambahkan', label: 'Kontak baru masuk dari sumber WhatsApp' },
      { kind: 'condition', title: 'Cek Sumber', label: 'Sumber kontak adalah WhatsApp' },
      { kind: 'action', title: 'Kirim WhatsApp', label: 'Kirim template "Selamat Datang" ke kontak' },
      { kind: 'action', title: 'Tambah Tag', label: 'Tambahkan tag "Baru" ke kontak' },
    ]),
  },
  {
    id: 'wf-2', name: 'Follow-up Deal Tidak Aktif', status: 'active', runCount: 24, lastRunAt: hoursAgo(2),
    nodes: layout('wf-2', [
      { kind: 'trigger', title: 'Deal Tidak Aktif', label: 'Deal tidak ada aktivitas selama 3 hari' },
      { kind: 'condition', title: 'Cek Status Deal', label: 'Status deal: Open' },
      { kind: 'condition', title: 'Cek Nilai Deal', label: 'Nilai deal lebih dari Rp 5.000.000' },
      { kind: 'action', title: 'Buat Tugas', label: 'Buat tugas follow-up untuk pemilik deal' },
      { kind: 'action', title: 'Kirim Notifikasi', label: 'Kirim notifikasi ke pemilik deal' },
    ]),
  },
  {
    id: 'wf-3', name: 'Reminder Meeting', status: 'active', runCount: 42, lastRunAt: hoursAgo(24),
    nodes: layout('wf-3', [
      { kind: 'trigger', title: '30 Menit Sebelum Meeting', label: 'Jadwal meeting akan dimulai dalam 30 menit' },
      { kind: 'condition', title: 'Cek Jenis Tugas', label: 'Jenis tugas: Meeting' },
      { kind: 'action', title: 'Kirim Notifikasi', label: 'Kirim notifikasi ke penugas' },
      { kind: 'action', title: 'Kirim WhatsApp', label: 'Kirim WhatsApp pengingat ke client' },
    ]),
  },
  {
    id: 'wf-4', name: 'Eskalasi Chat Belum Dibalas', status: 'active', runCount: 12, lastRunAt: hoursAgo(5),
    nodes: layout('wf-4', [
      { kind: 'trigger', title: 'Chat Belum Dibalas', label: 'Chat belum dibalas lebih dari 1 jam' },
      { kind: 'condition', title: 'Cek Jam Kerja', label: 'Jam kerja: 08.00–17.00' },
      { kind: 'action', title: 'Tandai Prioritas', label: 'Tandai chat sebagai prioritas tinggi' },
      { kind: 'action', title: 'Kirim Notifikasi', label: 'Kirim notifikasi ke supervisor' },
    ]),
  },
  {
    id: 'wf-5', name: 'Tandai Tugas Selesai Otomatis', status: 'inactive', runCount: 8, lastRunAt: hoursAgo(72),
    nodes: layout('wf-5', [
      { kind: 'trigger', title: 'Pesanan Lunas', label: 'Status pesanan berubah menjadi Lunas' },
      { kind: 'action', title: 'Selesaikan Tugas', label: 'Tandai tugas terkait sebagai selesai' },
    ]),
  },
];

export function getDummyWorkflow(id: string): DummyWorkflow | null {
  return DUMMY_WORKFLOWS.find((w) => w.id === id) ?? null;
}
