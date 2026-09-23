'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  api, ApiError, type DocumentLayoutElement, type BroadcastPreview, type BroadcastDetail, type ContactDetail,
  type Task,
} from '@/lib/api';
import { t } from '@/lib/copy';
import { assertCsrf, CsrfError } from '@/lib/csrf';

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Non-blocking — the action itself succeeded, this just has something
   * worth telling the user (e.g. a meeting saved fine but couldn't reach
   * Google Calendar). Rendered differently from `error`, which means the
   * action itself failed. */
  notice?: string;
}

const CALENDAR_STATUS_NOTICE: Record<string, string> = {
  not_connected: 'Meeting tersimpan. Hubungkan Google Calendar Anda di halaman Tugas supaya otomatis masuk kalender.',
  reconnect_required: 'Meeting tersimpan, tapi koneksi Google Calendar Anda perlu disambungkan ulang.',
  failed: 'Meeting tersimpan, tapi gagal membuat acara di Google Calendar.',
};

/**
 * The "Jadwal Meeting" field on Client forms (`ClientForm`/`ClientDetailDrawer`/
 * `ClientAddDrawer`) is really a shortcut onto the same real meeting task
 * "Jadwal Meeting" (the button/drawer) creates — not a second, disconnected
 * date to keep in sync. `existing` is the contact's current nearest open
 * meeting task, carried over from the form as a hidden field (see
 * `ClientForm`) so this can tell "the date on screen is unchanged" apart from
 * "this is a reschedule" apart from "book a brand new one" — comparing
 * against it, not against `contact.scheduleMeeting` (dead — see
 * `ClientQuickAddTaskDrawer`), is what stops a save that didn't touch this
 * field at all from spawning a duplicate meeting every time.
 */
async function syncScheduleMeetingTask(args: {
  contactId: string; name: string | null; scheduleMeeting: string; existing: Task | null;
}): Promise<{ notice?: string }> {
  const changed = !args.existing
    || new Date(args.scheduleMeeting).getTime() !== new Date(args.existing.dueAt).getTime();
  if (!changed) return {};

  try {
    let calendarStatus: string | null | undefined;
    if (args.existing) {
      const res = await api<{ calendarStatus?: string | null }>(`/v1/tasks/${args.existing.id}`, {
        method: 'PATCH',
        body: {
          title: args.existing.title, dueAt: args.scheduleMeeting,
          notes: args.existing.notes ?? undefined, dealId: args.existing.dealId ?? undefined,
          assigneeId: args.existing.assigneeId ?? undefined, kind: args.existing.kind,
          meetingLink: args.existing.meetingLink ?? undefined, priority: args.existing.priority,
          repeatUnit: args.existing.repeatUnit, repeatInterval: args.existing.repeatInterval,
          repeatUntil: args.existing.repeatUntil,
        },
      });
      calendarStatus = res.calendarStatus;
    } else {
      const res = await api<{ calendarStatus?: string | null }>('/v1/tasks', {
        method: 'POST',
        body: {
          contactId: args.contactId, title: `Meeting dengan ${args.name ?? 'client'}`,
          dueAt: args.scheduleMeeting, kind: 'meeting',
        },
      });
      calendarStatus = res.calendarStatus;
    }
    return calendarStatus ? { notice: CALENDAR_STATUS_NOTICE[calendarStatus] } : {};
  } catch (err) {
    return { notice: err instanceof ApiError ? err.message : t.tasks.failed };
  }
}

/**
 * Every change goes through a server action, so the access token stays on the
 * server and the browser never holds a credential it could leak. They all work
 * with JavaScript switched off, which matters on a cheap phone with a bad line.
 */
export async function sendMessage(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const conversationId = String(form.get('conversationId') ?? '');
  const body = String(form.get('body') ?? '').trim();
  const templateName = String(form.get('templateName') ?? '').trim();

  if (!body) return { ok: false, error: t.chats.emptyMessage };

  try {
    await api(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { body, ...(templateName ? { templateName } : {}) },
    });
    revalidatePath('/obrolan', 'layout');
    revalidatePath('/chat-wa', 'layout');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.chats.sendFailed };
  }
}

export async function assignConversation(form: FormData): Promise<void> {
  await assertCsrf(form);
  const conversationId = String(form.get('conversationId') ?? '');
  const raw = String(form.get('assigneeId') ?? '');
  await api(`/v1/conversations/${conversationId}/assign`, {
    method: 'POST',
    body: { assigneeId: raw === '' ? null : raw },
  });
  revalidatePath('/obrolan', 'layout');
  revalidatePath('/chat-wa', 'layout');
}

export async function resolveConversation(form: FormData): Promise<void> {
  await assertCsrf(form);
  const conversationId = String(form.get('conversationId') ?? '');
  await api(`/v1/conversations/${conversationId}/resolve`, { method: 'POST' });
  revalidatePath('/obrolan', 'layout');
  revalidatePath('/chat-wa', 'layout');
}

/* ----------------------------------------------------------------- pesanan */

export async function markOrderPaid(form: FormData): Promise<void> {
  await assertCsrf(form);
  const orderId = String(form.get('orderId') ?? '');
  await api(`/v1/orders/${orderId}/mark-paid`, { method: 'POST' });
  revalidatePath('/pesanan');
}

export async function fulfillOrder(form: FormData): Promise<void> {
  await assertCsrf(form);
  const orderId = String(form.get('orderId') ?? '');
  await api(`/v1/orders/${orderId}/fulfill`, { method: 'POST' });
  revalidatePath('/pesanan');
}

export async function cancelOrder(form: FormData): Promise<void> {
  await assertCsrf(form);
  const orderId = String(form.get('orderId') ?? '');
  await api(`/v1/orders/${orderId}/cancel`, { method: 'POST' });
  revalidatePath('/pesanan');
}

/* ------------------------------------------------------------------- tugas */

function readTaskForm(form: FormData) {
  return {
    contactId: String(form.get('contactId') ?? '').trim(),
    brandId: String(form.get('brandId') ?? '').trim(),
    title: String(form.get('title') ?? '').trim(),
    dueAt: String(form.get('dueAt') ?? '').trim(),
    notes: String(form.get('notes') ?? '').trim(),
    dealId: String(form.get('dealId') ?? '').trim(),
    assigneeId: String(form.get('assigneeId') ?? '').trim(),
    kind: String(form.get('kind') ?? '').trim(),
    meetingLink: String(form.get('meetingLink') ?? '').trim(),
    priority: String(form.get('priority') ?? '').trim(),
    repeatUnit: String(form.get('repeatUnit') ?? '').trim(),
    repeatInterval: String(form.get('repeatInterval') ?? '').trim(),
    repeatUntil: String(form.get('repeatUntil') ?? '').trim(),
  };
}

/**
 * A task can point at a Contact or (since the table no longer requires one)
 * a Brand directly — `/v1/tasks` accepts either. Exactly one of
 * contactId/brandId is expected; the form only ever shows one picker at a time.
 */
async function submitTaskForm(fields: ReturnType<typeof readTaskForm>): Promise<{ notice?: string }> {
  const res = await api<{ calendarStatus?: string | null }>('/v1/tasks', {
    method: 'POST',
    body: {
      contactId: fields.contactId || undefined, brandId: fields.brandId || undefined,
      title: fields.title, dueAt: fields.dueAt,
      notes: fields.notes || undefined, dealId: fields.dealId || undefined, assigneeId: fields.assigneeId || undefined,
      kind: fields.kind || undefined, meetingLink: fields.meetingLink || undefined, priority: fields.priority || undefined,
      repeatUnit: fields.repeatUnit || undefined,
      repeatInterval: fields.repeatUnit ? (Number(fields.repeatInterval) || 1) : undefined,
      repeatUntil: fields.repeatUnit && fields.repeatUntil ? fields.repeatUntil : undefined,
    },
  });
  const notice = res.calendarStatus ? CALENDAR_STATUS_NOTICE[res.calendarStatus] : undefined;
  return notice ? { notice } : {};
}

export async function createTask(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const fields = readTaskForm(form);
  if ((!fields.contactId && !fields.brandId) || !fields.title || !fields.dueAt) {
    return { ok: false, error: t.tasks.failed };
  }

  try {
    await submitTaskForm(fields);
    revalidatePath('/tugas');
    if (fields.brandId) revalidatePath(`/brand/${fields.brandId}`);
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.failed };
  }
  redirect('/tugas');
}

/**
 * Same as `createTask`, minus the redirect — for the slide-in drawer on the
 * Tugas table itself, which is already on `/tugas` and just needs the list to
 * refresh and the panel to close, not a navigation.
 */
export async function createTaskInline(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const fields = readTaskForm(form);
  if ((!fields.contactId && !fields.brandId) || !fields.title || !fields.dueAt) {
    return { ok: false, error: t.tasks.failed };
  }

  try {
    const { notice } = await submitTaskForm(fields);
    revalidatePath('/tugas');
    if (fields.brandId) revalidatePath(`/brand/${fields.brandId}`);
    if (fields.contactId) { revalidatePath('/client/deal'); revalidatePath('/client/proses'); }
    return notice ? { ok: true, notice } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.failed };
  }
}

export async function updateTask(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const taskId = String(form.get('taskId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const dueAt = String(form.get('dueAt') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  const dealId = String(form.get('dealId') ?? '').trim();
  const assigneeId = String(form.get('assigneeId') ?? '').trim();
  const kind = String(form.get('kind') ?? '').trim();
  const meetingLink = String(form.get('meetingLink') ?? '').trim();
  const priority = String(form.get('priority') ?? '').trim();
  const repeatUnit = String(form.get('repeatUnit') ?? '').trim();
  const repeatInterval = String(form.get('repeatInterval') ?? '').trim();
  const repeatUntil = String(form.get('repeatUntil') ?? '').trim();

  if (!taskId || !title || !dueAt) return { ok: false, error: t.tasks.failed };

  try {
    await api(`/v1/tasks/${taskId}`, {
      method: 'PATCH',
      body: {
        title, dueAt,
        notes: notes || undefined, dealId: dealId || undefined, assigneeId: assigneeId || undefined,
        kind: kind || undefined, meetingLink: meetingLink || undefined, priority: priority || undefined,
        repeatUnit: repeatUnit || null,
        repeatInterval: repeatUnit ? (Number(repeatInterval) || 1) : 1,
        repeatUntil: repeatUnit && repeatUntil ? repeatUntil : null,
      },
    });
    revalidatePath('/tugas');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.failed };
  }
}

export async function markTaskDone(form: FormData): Promise<void> {
  await assertCsrf(form);
  const taskId = String(form.get('taskId') ?? '');
  await api(`/v1/tasks/${taskId}/done`, { method: 'POST' });
  revalidatePath('/tugas');
}

export async function cancelTask(form: FormData): Promise<void> {
  await assertCsrf(form);
  const taskId = String(form.get('taskId') ?? '');
  await api(`/v1/tasks/${taskId}/cancel`, { method: 'POST' });
  revalidatePath('/tugas');
}

/** The "Kirim Email" dialog on a Meeting task — sent synchronously, so the error (if any) comes straight back. */
export async function sendMeetingEmail(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const taskId = String(form.get('taskId') ?? '');
  const to = String(form.get('to') ?? '').trim();
  if (!to) return { ok: false, error: t.tasks.sendEmailFailed };

  try {
    await api(`/v1/tasks/${taskId}/send-email`, { method: 'POST', body: { to } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.sendEmailFailed };
  }
}

export interface AddTaskKindResult {
  ok: boolean;
  error?: string;
  kind?: { id: string; name: string };
}

/**
 * Called directly from the Jenis field's "+ Tambah" button, not a `<form>`
 * submit — the caller builds its own FormData (via `useCsrfToken`) so it can
 * read the created kind back and drop it straight into the dropdown, without
 * a full page reload.
 */
export async function addTaskKind(form: FormData): Promise<AddTaskKindResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { ok: false, error: t.tasks.addKindFailed };

  try {
    const kind = await api<{ id: string; name: string }>('/v1/task-kinds', { method: 'POST', body: { name } });
    revalidatePath('/tugas');
    revalidatePath('/tugas/baru');
    return { ok: true, kind };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.addKindFailed };
  }
}

/* ----------------------------------------------------------------- client */

function readClientForm(form: FormData) {
  const displayName = String(form.get('displayName') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const igUsername = String(form.get('igUsername') ?? '').trim();
  const tags = String(form.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const address = String(form.get('address') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  const storeName = String(form.get('storeName') ?? '').trim();
  const storeStatus = String(form.get('storeStatus') ?? '').trim();
  const scheduleMeeting = String(form.get('scheduleMeeting') ?? '').trim();
  const clientStatus = String(form.get('clientStatus') ?? '').trim();
  // The contact's current nearest open meeting task, round-tripped through a
  // hidden field by `ClientForm`/`ClientDetailDrawer` — see
  // `syncScheduleMeetingTask`. Malformed/tampered JSON is treated the same
  // as "no existing meeting", not a form error: worst case that creates one
  // extra meeting task rather than failing the whole save.
  const meetingTaskRaw = String(form.get('meetingTask') ?? '').trim();
  let meetingTask: Task | null = null;
  if (meetingTaskRaw) {
    try { meetingTask = JSON.parse(meetingTaskRaw) as Task; } catch { meetingTask = null; }
  }
  return {
    displayName, phone, email, igUsername, tags, address, notes, storeName, storeStatus, scheduleMeeting,
    clientStatus, meetingTask,
  };
}

export async function createClient(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const {
    displayName, phone, email, igUsername, tags, address, notes, storeName, storeStatus, scheduleMeeting,
    clientStatus,
  } = readClientForm(form);

  try {
    const created = await api<{ id: string }>('/v1/contacts', {
      method: 'POST',
      body: {
        ...(displayName ? { displayName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(igUsername ? { igUsername } : {}),
        ...(address ? { address } : {}),
        ...(notes ? { notes } : {}),
        ...(storeName ? { storeName } : {}),
        ...(storeStatus ? { storeStatus } : {}),
        ...(scheduleMeeting ? { scheduleMeeting } : {}),
        ...(clientStatus ? { clientStatus } : {}),
        tags,
      },
    });
    // Best-effort, notice or not — this redirects right after, so there's
    // nowhere left on screen to show one even if Calendar isn't connected.
    if (scheduleMeeting) {
      await syncScheduleMeetingTask({
        contactId: created.id, name: displayName || null, scheduleMeeting, existing: null,
      }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.client.failed };
  }
  revalidatePath('/client/deal');
  revalidatePath('/client/proses');
  revalidatePath('/tugas');
  redirect('/client/proses');
}

/**
 * Same as `createClient`, minus the redirect — for the slide-in drawer on
 * the Client Deal/On Proses tables themselves, which are already on one of
 * those pages and just need the list to refresh and the panel to close, not
 * a navigation. The full-page form at `/client/baru` still exists and still
 * works exactly as before; this is an additional, faster path in.
 */
export async function createClientInline(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const {
    displayName, phone, email, igUsername, tags, address, notes, storeName, storeStatus, scheduleMeeting,
    clientStatus,
  } = readClientForm(form);

  try {
    const created = await api<{ id: string }>('/v1/contacts', {
      method: 'POST',
      body: {
        ...(displayName ? { displayName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(igUsername ? { igUsername } : {}),
        ...(address ? { address } : {}),
        ...(notes ? { notes } : {}),
        ...(storeName ? { storeName } : {}),
        ...(storeStatus ? { storeStatus } : {}),
        ...(scheduleMeeting ? { scheduleMeeting } : {}),
        ...(clientStatus ? { clientStatus } : {}),
        tags,
      },
    });

    let notice: string | undefined;
    if (scheduleMeeting) {
      notice = (await syncScheduleMeetingTask({
        contactId: created.id, name: displayName || null, scheduleMeeting, existing: null,
      })).notice;
    }

    revalidatePath('/client/deal');
    revalidatePath('/client/proses');
    revalidatePath('/tugas');
    return notice ? { ok: true, notice } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.client.failed };
  }
}

export async function updateClient(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const {
    displayName, phone, email, igUsername, tags, address, notes, storeName, storeStatus, scheduleMeeting,
    clientStatus, meetingTask,
  } = readClientForm(form);

  try {
    await api(`/v1/contacts/${id}`, {
      method: 'PATCH',
      body: {
        displayName: displayName || null, phone: phone || null, email: email || null,
        igUsername: igUsername || null,
        address: address || null, notes: notes || null, tags,
        storeName: storeName || null, storeStatus: storeStatus || null,
        scheduleMeeting: scheduleMeeting || null,
        clientStatus: clientStatus || 'on_progress',
      },
    });

    let notice: string | undefined;
    if (scheduleMeeting) {
      notice = (await syncScheduleMeetingTask({
        contactId: id, name: displayName || null, scheduleMeeting, existing: meetingTask,
      })).notice;
    }

    revalidatePath('/client/deal');
    revalidatePath('/client/proses');
    revalidatePath('/tugas');
    revalidatePath(`/client/${id}`);
    return notice ? { ok: true, notice } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.client.failed };
  }
}

export async function deleteClient(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  await api(`/v1/contacts/${id}`, { method: 'DELETE' });
  revalidatePath('/client/deal');
  revalidatePath('/client/proses');
  redirect('/client/proses');
}

/* ------------------------------------------------------------------- brand */

function readBrandForm(form: FormData) {
  const name = String(form.get('name') ?? '').trim();
  const picName = String(form.get('picName') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const instagram = String(form.get('instagram') ?? '').trim();
  const website = String(form.get('website') ?? '').trim();
  const category = String(form.get('category') ?? '').trim();
  const city = String(form.get('city') ?? '').trim();
  const source = String(form.get('source') ?? '').trim();
  const assigneeId = String(form.get('assigneeId') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  return { name, picName, phone, email, instagram, website, category, city, source, assigneeId, notes };
}

export async function createBrand(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const { name, picName, phone, email, instagram, website, category, city, source, assigneeId, notes } =
    readBrandForm(form);
  if (!name) return { ok: false, error: t.brand.failed };

  let created: { id: string };
  try {
    created = await api<{ id: string }>('/v1/brands', {
      method: 'POST',
      body: {
        name,
        ...(picName ? { picName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(instagram ? { instagram } : {}),
        ...(website ? { website } : {}),
        ...(category ? { category } : {}),
        ...(city ? { city } : {}),
        ...(source ? { source } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(notes ? { notes } : {}),
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
  revalidatePath('/brand');
  redirect(`/brand/${created.id}`);
}

export async function updateBrand(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const { name, picName, phone, email, instagram, website, category, city, source, assigneeId, notes } =
    readBrandForm(form);
  if (!name) return { ok: false, error: t.brand.failed };

  try {
    await api(`/v1/brands/${id}`, {
      method: 'PATCH',
      body: {
        name,
        ...(picName ? { picName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(instagram ? { instagram } : {}),
        ...(website ? { website } : {}),
        ...(category ? { category } : {}),
        ...(city ? { city } : {}),
        ...(source ? { source } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(notes ? { notes } : {}),
      },
    });
    revalidatePath('/brand');
    revalidatePath(`/brand/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
}


export async function setBrandStatus(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  const status = String(form.get('status') ?? '');
  await api(`/v1/brands/${id}/status`, { method: 'POST', body: { status } });
  revalidatePath('/brand');
  revalidatePath(`/brand/${id}`);
}

export async function deleteBrand(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  try {
    await api(`/v1/brands/${id}`, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
  revalidatePath('/brand');
  redirect('/brand');
}

export interface ImportBrandsResult {
  ok: boolean;
  error?: string;
  created?: number;
  skipped?: { row: number; message: string }[];
}

/**
 * The Brand Management import page — rows are already parsed and previewed
 * client-side (from whatever spreadsheet the agent uploaded), so this just
 * forwards the clean array to the bulk-create endpoint and hands back a
 * summary rather than redirecting, since the page's own job now is showing
 * the agent what happened row by row.
 */
export async function importBrands(_prev: ImportBrandsResult | null, form: FormData): Promise<ImportBrandsResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  let rows: unknown;
  try {
    rows = JSON.parse(String(form.get('rows') ?? '[]'));
  } catch {
    return { ok: false, error: t.brandManagement.parseFailed };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: t.brandManagement.noRows };

  try {
    const result = await api<{ created: number; errors: { row: number; message: string }[] }>('/v1/brands/import', {
      method: 'POST',
      body: { rows },
    });
    revalidatePath('/brand');
    revalidatePath('/brand-management');
    return { ok: true, created: result.created, skipped: result.errors };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brandManagement.importFailed };
  }
}

/**
 * Same brand record, same API, as `createBrand`/`updateBrand`/`deleteBrand`
 * — only the redirect target differs, so Brand Management's own table/detail
 * pages land back on `/brand-management` instead of Tracker's `/brand`.
 * Kept separate rather than parameterising the Tracker actions so Tracker's
 * own behavior never has to change to support a second caller.
 */
export async function createBrandFromManagement(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const { name, picName, phone, email, instagram, website, category, city, source, assigneeId, notes } =
    readBrandForm(form);
  if (!name) return { ok: false, error: t.brand.failed };

  let created: { id: string };
  try {
    created = await api<{ id: string }>('/v1/brands', {
      method: 'POST',
      body: {
        name,
        ...(picName ? { picName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(instagram ? { instagram } : {}),
        ...(website ? { website } : {}),
        ...(category ? { category } : {}),
        ...(city ? { city } : {}),
        ...(source ? { source } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(notes ? { notes } : {}),
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
  revalidatePath('/brand-management');
  redirect(`/brand-management/${created.id}`);
}

export async function updateBrandFromManagement(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const { name, picName, phone, email, instagram, website, category, city, source, assigneeId, notes } =
    readBrandForm(form);
  if (!name) return { ok: false, error: t.brand.failed };

  try {
    await api(`/v1/brands/${id}`, {
      method: 'PATCH',
      body: {
        name,
        ...(picName ? { picName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(instagram ? { instagram } : {}),
        ...(website ? { website } : {}),
        ...(category ? { category } : {}),
        ...(city ? { city } : {}),
        ...(source ? { source } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(notes ? { notes } : {}),
      },
    });
    revalidatePath('/brand-management');
    revalidatePath(`/brand-management/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
}

export async function deleteBrandFromManagement(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  try {
    await api(`/v1/brands/${id}`, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.failed };
  }
  revalidatePath('/brand-management');
  redirect('/brand-management');
}

/**
 * The chat icon on a Brand card/row — resolves the brand's Contact and a
 * WA-bridge conversation on the server, then lands on the internal Chat WA
 * thread instead of opening wa.me in a new tab.
 */
export async function openBrandChat(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const brandId = String(form.get('id') ?? '');
  if (!brandId) return { ok: false, error: t.brand.chatFailed };

  let conversationId: string;
  try {
    const res = await api<{ conversationId: string }>(`/v1/brands/${brandId}/chat`, { method: 'POST' });
    conversationId = res.conversationId;
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.brand.chatFailed };
  }
  revalidatePath('/brand');
  redirect(`/chat-wa/${conversationId}`);
}

/* --------------------------------------------------------------- dokumen */

function readDocumentForm(form: FormData) {
  return {
    name: String(form.get('name') ?? '').trim(),
    kind: String(form.get('kind') ?? '').trim(),
    model: String(form.get('model') ?? '').trim(),
    useTemplate: String(form.get('useTemplate') ?? '') === 'ya',
  };
}

export async function createDocument(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const { name, kind, model, useTemplate } = readDocumentForm(form);
  if (!name || !kind || !model) return { ok: false, error: t.document.failed };

  try {
    await api('/v1/documents', { method: 'POST', body: { name, kind, model, useTemplate } });
    revalidatePath('/customize/dokumen');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.document.failed };
  }
}

export async function updateDocument(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const { name, kind, model, useTemplate } = readDocumentForm(form);
  if (!name || !kind || !model) return { ok: false, error: t.document.failed };

  try {
    await api(`/v1/documents/${id}`, { method: 'PATCH', body: { name, kind, model, useTemplate } });
    revalidatePath('/customize/dokumen');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.document.failed };
  }
}

export interface AddDocumentKindResult {
  ok: boolean;
  error?: string;
  kind?: { id: string; name: string };
}

/** Called directly from the Jenis field's "+ Tambah" button — same shape as `addTaskKind`. */
export async function addDocumentKind(form: FormData): Promise<AddDocumentKindResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { ok: false, error: t.document.addKindFailed };

  try {
    const kind = await api<{ id: string; name: string }>('/v1/document-kinds', { method: 'POST', body: { name } });
    revalidatePath('/customize/dokumen');
    return { ok: true, kind };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.document.addKindFailed };
  }
}

export interface AddDocumentModelResult {
  ok: boolean;
  error?: string;
  model?: { id: string; name: string };
}

/** Called directly from the Model field's "+ Tambah" button — same shape as `addTaskKind`. */
export async function addDocumentModel(form: FormData): Promise<AddDocumentModelResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { ok: false, error: t.document.addModelFailed };

  try {
    const model = await api<{ id: string; name: string }>('/v1/document-models', { method: 'POST', body: { name } });
    revalidatePath('/customize/dokumen');
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.document.addModelFailed };
  }
}

/**
 * Called from the canvas editor's "Simpan" button, not a `<form>` submit —
 * the caller builds its own FormData (via `useCsrfToken`) with the whole
 * element array serialized as JSON, same pattern as `addTaskKind`.
 */
export async function saveDocumentLayout(form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const documentId = String(form.get('documentId') ?? '');
  const raw = String(form.get('layout') ?? '');
  const pageSize = String(form.get('pageSize') ?? '');
  const marginTopMm = Number(form.get('marginTopMm'));
  const marginRightMm = Number(form.get('marginRightMm'));
  const marginBottomMm = Number(form.get('marginBottomMm'));
  const marginLeftMm = Number(form.get('marginLeftMm'));
  if (!documentId || !raw || !pageSize) return { ok: false, error: t.document.editorFailed };
  if ([marginTopMm, marginRightMm, marginBottomMm, marginLeftMm].some((n) => !Number.isFinite(n))) {
    return { ok: false, error: t.document.editorFailed };
  }

  let layout: DocumentLayoutElement[];
  try {
    layout = JSON.parse(raw);
  } catch {
    return { ok: false, error: t.document.editorFailed };
  }

  try {
    await api(`/v1/documents/${documentId}/layout`, {
      method: 'PATCH', body: { layout, pageSize, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm },
    });
    revalidatePath('/customize/dokumen');
    revalidatePath(`/customize/dokumen/${documentId}/editor`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.document.editorFailed };
  }
}

export async function deleteDocument(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  await api(`/v1/documents/${id}`, { method: 'DELETE' });
  revalidatePath('/customize/dokumen');
  redirect('/customize/dokumen');
}

export async function moveDeal(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const dealId = String(form.get('dealId') ?? '');
  const stageId = String(form.get('stageId') ?? '');
  try {
    await api(`/v1/deals/${dealId}`, { method: 'PATCH', body: { stageId } });
    revalidatePath('/deal');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.sales.moveFailed };
  }
}

/** The "+" on a kanban column — creates the deal already in that stage. */
export async function createDealAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const brandId = String(form.get('brandId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const amountIdr = Number(form.get('amountIdr') ?? 0);
  const stageId = String(form.get('stageId') ?? '');
  if (!brandId || !title || !stageId || !Number.isFinite(amountIdr) || amountIdr < 0) {
    return { ok: false, error: t.sales.addFailed };
  }

  try {
    await api('/v1/deals', {
      method: 'POST',
      body: { brandId, title, amountIdr: Math.round(amountIdr), stageId },
    });
    revalidatePath('/deal');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.sales.addFailed };
  }
}

/**
 * The "Tambah deal" button on a Chat WA thread — no form, one click: a deal
 * for whichever brand this contact is the PIC of (falling back to the
 * contact itself if none), value 0 for now, straight into the "Baru" stage
 * (stageId omitted lands it in the default pipeline's first stage). The
 * agent fills in the real amount afterward from the Deal page's own Edit.
 */
export async function createDealFromConversation(form: FormData): Promise<void> {
  await assertCsrf(form);
  const contactId = String(form.get('contactId') ?? '');
  const brandId = String(form.get('brandId') ?? '');
  const title = String(form.get('title') ?? '').trim() || 'Deal Baru';
  const conversationId = String(form.get('conversationId') ?? '');
  if (!contactId && !brandId) return;

  await api('/v1/deals', {
    method: 'POST',
    body: {
      contactId: contactId || undefined, brandId: brandId || undefined, title, amountIdr: 0,
      conversationId: conversationId || undefined,
    },
  });
  revalidatePath('/deal');
  revalidatePath('/chat-wa', 'layout');
  redirect('/deal');
}

/**
 * The "Tambah Client" button on a Chat WA thread — this contact already has
 * a row in `contacts` (they messaged in), so this tags them `customer`
 * rather than creating a second one; a fresh `POST /v1/contacts` for the
 * same phone number would just collide with the unique index and fail. A
 * schedule-meeting date is required so the new client lands in Client On
 * Proses immediately instead of appearing in neither list. Fetches the
 * current record first so fields this form doesn't touch (address, notes,
 * store status…) aren't wiped by the PATCH, which expects the whole record.
 */
export async function addClientFromChat(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const contactId = String(form.get('contactId') ?? '');
  const displayName = String(form.get('displayName') ?? '').trim();
  // The meeting date is optional here — filling it in is what additionally
  // lands this contact on Client On Proses (see below), but adding someone
  // as a client shouldn't require scheduling a meeting with them yet.
  const scheduleMeeting = String(form.get('scheduleMeeting') ?? '').trim();
  if (!contactId) return { ok: false, error: t.chats.addClientFailed };

  try {
    const current = await api<ContactDetail>(`/v1/contacts/${contactId}`);
    const tags = current.tags.includes('customer') ? current.tags : [...current.tags, 'customer'];
    const name = displayName || current.displayName;
    await api(`/v1/contacts/${contactId}`, {
      method: 'PATCH',
      body: {
        // `current.phone` already comes back masked or real depending on this
        // actor's own `contact:export` permission — sending it straight back
        // is safe either way, since the PATCH route itself drops it when the
        // actor can't reveal numbers, the same rule `updateClient` follows.
        // Every other field here is likewise just carried over unchanged —
        // this form only ever means to touch `displayName`/`tags` (and,
        // below, `scheduleMeeting`) — but the PATCH route always writes the
        // whole record, so every field it requires has to be sent regardless.
        displayName: name, phone: current.phone, email: current.email, igUsername: current.igUsername,
        address: current.address, notes: current.notes, tags,
        storeName: current.storeName, storeStatus: current.storeStatus,
        scheduleMeeting: scheduleMeeting || null, clientStatus: current.clientStatus,
      },
    });

    // The `customer` tag above already puts this contact on Client On
    // Proses on its own — a meeting date here is optional, purely for the
    // "Jadwal Meeting" column, which reads real meeting tasks, not the
    // `scheduleMeeting` attribute just patched (kept only because a couple
    // of older forms still display it). Without a real task, a filled-in
    // date would save something that then shows up nowhere.
    let notice: string | undefined;
    if (scheduleMeeting) {
      try {
        const res = await api<{ calendarStatus?: string | null }>('/v1/tasks', {
          method: 'POST',
          body: {
            contactId, title: `Meeting dengan ${name ?? 'client'}`, dueAt: scheduleMeeting, kind: 'meeting',
          },
        });
        notice = res.calendarStatus ? CALENDAR_STATUS_NOTICE[res.calendarStatus] : undefined;
      } catch (err) {
        notice = err instanceof ApiError ? err.message : t.chats.addClientFailed;
      }
    }

    revalidatePath('/client/proses');
    revalidatePath('/client/deal');
    revalidatePath('/tugas');
    revalidatePath('/chat-wa', 'layout');
    revalidatePath('/chat-ig', 'layout');
    return notice ? { ok: true, notice } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.chats.addClientFailed };
  }
}

export async function updateDealDetails(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const notes = String(form.get('notes') ?? '').trim();
  const expectedCloseOn = String(form.get('expectedCloseOn') ?? '').trim();
  const brandId = String(form.get('brandId') ?? '').trim();
  // Only the Edit-drawer form (list page) sends these — the detail page's own
  // form doesn't touch amount/title, so both stay untouched when absent.
  const amountRaw = form.get('amountIdr');
  const titleRaw = form.get('title');
  const amountIdr = amountRaw !== null ? Number(amountRaw) : undefined;
  const title = titleRaw !== null ? String(titleRaw).trim() : undefined;
  if (amountIdr !== undefined && (!Number.isFinite(amountIdr) || amountIdr < 0)) {
    return { ok: false, error: t.dealDetail.failed };
  }

  try {
    await api(`/v1/deals/${id}/details`, {
      method: 'PATCH',
      body: {
        notes: notes || null, expectedCloseOn: expectedCloseOn || null, brandId: brandId || null,
        ...(amountIdr !== undefined ? { amountIdr: Math.round(amountIdr) } : {}),
        ...(title ? { title } : {}),
      },
    });
    revalidatePath(`/deal/${id}`);
    revalidatePath('/deal');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.dealDetail.failed };
  }
}

export async function deleteDeal(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  await api(`/v1/deals/${id}`, { method: 'DELETE' });
  revalidatePath('/deal');
  redirect('/deal');
}

export async function inviteMember(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const payload = {
    name: String(form.get('name') ?? '').trim(),
    email: String(form.get('email') ?? '').trim(),
    password: String(form.get('password') ?? ''),
    role: String(form.get('role') ?? 'agent'),
  };
  if (payload.password.length < 12) return { ok: false, error: t.team.passwordShort };

  try {
    await api('/v1/members', { method: 'POST', body: payload });
    revalidatePath('/tim');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.team.addFailed };
  }
}

/** Accept, edit or bin an Autopilot draft. */
export async function decideDraft(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const conversationId = String(form.get('conversationId') ?? '');
  const draftId = String(form.get('draftId') ?? '');
  const action = String(form.get('action') ?? 'use') as 'use' | 'discard';
  const edited = String(form.get('body') ?? '').trim();

  try {
    await api(`/v1/conversations/${conversationId}/drafts/${draftId}`, {
      method: 'POST',
      body: { action, ...(action === 'use' && edited ? { body: edited } : {}) },
    });
    revalidatePath('/obrolan', 'layout');
    revalidatePath('/chat-wa', 'layout');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.autopilot.failed };
  }
}

/** Turn Autopilot up or down. */
export async function setAutopilotMode(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const mode = String(form.get('mode') ?? 'suggest');
  try {
    await api('/v1/autopilot', { method: 'PUT', body: { mode } });
    revalidatePath('/pengaturan/autopilot');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.autopilot.failed };
  }
}

/* ------------------------------------------------------------ two-factor */

export interface MfaResult extends ActionResult {
  backupCodes?: string[];
}

export async function startMfa(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api('/v1/auth/mfa/setup', { method: 'POST', body: {} });
    revalidatePath('/pengaturan/keamanan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.security.failed };
  }
}

export async function enableMfa(_prev: MfaResult | null, form: FormData): Promise<MfaResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const code = String(form.get('code') ?? '').trim();
  try {
    const result = await api<{ backupCodes: string[] }>('/v1/auth/mfa/enable', {
      method: 'POST', body: { code },
    });
    revalidatePath('/pengaturan/keamanan');
    return { ok: true, backupCodes: result.backupCodes };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? t.security.codeWrong : t.security.failed };
  }
}

export async function disableMfa(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const code = String(form.get('code') ?? '').trim();
  try {
    await api('/v1/auth/mfa/disable', { method: 'POST', body: { code } });
    revalidatePath('/pengaturan/keamanan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? t.security.codeWrong : t.security.failed };
  }
}

export async function acknowledgeSecurityEvent(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const notes = String(form.get('notes') ?? '').trim();
  const reported = String(form.get('intent') ?? '') === 'reported';

  try {
    await api(`/v1/security/events/${id}/${reported ? 'notified' : 'acknowledge'}`, {
      method: 'POST', body: reported ? { notes } : { notes: notes || undefined },
    });
    revalidatePath('/pengaturan/keamanan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.security.failed };
  }
}

/* -------------------------------------------------------------- catalogue */

const num = (form: FormData, key: string): number | undefined => {
  const raw = String(form.get(key) ?? '').replace(/[^\d]/g, '');
  return raw === '' ? undefined : Number(raw);
};

/** One action for both adding and editing — the presence of an id decides. */
export async function saveCatalogueItem(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }

  const id = String(form.get('id') ?? '');
  const payload = {
    kind: String(form.get('kind') ?? 'product') as 'product' | 'faq' | 'policy',
    title: String(form.get('title') ?? '').trim(),
    body: String(form.get('body') ?? '').trim(),
    sku: String(form.get('sku') ?? '').trim() || undefined,
    priceIdr: num(form, 'priceIdr'),
    stock: num(form, 'stock'),
  };
  if (!payload.title) return { ok: false, error: t.catalogue.failed };

  try {
    if (id) {
      await api(`/v1/knowledge/${id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/v1/knowledge', { method: 'POST', body: payload });
    }
    revalidatePath('/pengaturan/katalog');
    revalidatePath('/pengaturan/autopilot');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.catalogue.failed };
  }
}

export async function removeCatalogueItem(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api(`/v1/knowledge/${String(form.get('id') ?? '')}`, { method: 'DELETE' });
    revalidatePath('/pengaturan/katalog');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.catalogue.failed };
  }
}

export async function saveShippingRate(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const area = String(form.get('area') ?? '').trim();
  if (!area) return { ok: false, error: t.catalogue.failed };

  try {
    await api('/v1/shipping-rates', {
      method: 'POST',
      body: { area, costIdr: num(form, 'costIdr') ?? 0, etaDays: num(form, 'etaDays') ?? 2 },
    });
    revalidatePath('/pengaturan/katalog');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.catalogue.failed };
  }
}

export async function removeShippingRate(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api(`/v1/shipping-rates/${String(form.get('id') ?? '')}`, { method: 'DELETE' });
    revalidatePath('/pengaturan/katalog');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.catalogue.failed };
  }
}

/* ----------------------------------------------------------- template pesan */

/** One action for both adding and editing — the presence of an id decides. */
export async function saveMessageTemplate(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }

  const id = String(form.get('id') ?? '');
  const payload = {
    name: String(form.get('name') ?? '').trim(),
    channel: String(form.get('channel') ?? 'whatsapp'),
    category: String(form.get('category') ?? 'utility'),
    language: String(form.get('language') ?? '').trim() || undefined,
    body: String(form.get('body') ?? '').trim(),
    status: String(form.get('status') ?? 'draft'),
    notes: String(form.get('notes') ?? '').trim() || undefined,
  };
  if (!payload.name || !payload.body) return { ok: false, error: t.messageTemplate.failed };

  try {
    if (id) {
      await api(`/v1/message-templates/${id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/v1/message-templates', { method: 'POST', body: payload });
    }
    revalidatePath('/broadcast/template-pesan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.messageTemplate.failed };
  }
}

export async function removeMessageTemplate(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api(`/v1/message-templates/${String(form.get('id') ?? '')}`, { method: 'DELETE' });
    revalidatePath('/broadcast/template-pesan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.messageTemplate.failed };
  }
}

/* --------------------------------------------------------- pengaturan email */

/**
 * Leaving the SMTP field blank keeps whatever is already saved — it's never
 * sent back to the browser to redisplay, so a blank field can't mean "clear
 * it" without a separate explicit control this form doesn't have yet.
 */
export async function saveEmailSettings(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const smtpUrl = String(form.get('smtpUrl') ?? '').trim();
  const emailFrom = String(form.get('emailFrom') ?? '').trim();

  try {
    await api('/v1/settings/email', {
      method: 'PATCH',
      body: { ...(smtpUrl ? { smtpUrl } : {}), emailFrom },
    });
    revalidatePath('/pengaturan/email');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.emailSettings.failed };
  }
}

/* ------------------------------------------------------------- ig bridge */

export interface IgBridgeResult {
  ok: boolean;
  error?: string;
  status?: 'ready' | 'challenge_required' | 'awaiting_login';
  challengeType?: 'two_factor' | 'checkpoint' | 'unknown';
}

/**
 * Connecting Facebook takes no credential — see `apps/fb-bridge`. All the CRM
 * sends is which Page to watch; the operator then logs in by hand in a browser
 * window the bridge opens on its own machine. That is why this returns
 * `awaiting_login` rather than a success: the real work happens somewhere this
 * request cannot see, and the page polls for the outcome.
 */
export interface FbBridgeResult extends ActionResult {
  status?: 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';
}

export async function connectFacebookBridge(_prev: FbBridgeResult | null, form: FormData): Promise<FbBridgeResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const pageId = String(form.get('pageId') ?? '').trim();
  const pageName = String(form.get('pageName') ?? '').trim();
  if (!pageId || !pageName) return { ok: false, error: t.facebookBridge.missingFields };

  // Left off the request entirely when blank rather than sent as an empty
  // string: the API reads an absent asset id as "this is a personal account",
  // which is a different thing from one the operator typed wrongly.
  const assetId = String(form.get('assetId') ?? '').trim();
  if (assetId && !/^\d{6,}$/.test(assetId)) {
    return { ok: false, error: t.facebookBridge.assetIdInvalid };
  }

  try {
    const res = await api<{ status: FbBridgeResult['status']; lastError?: string | null }>(
      '/v1/facebook-bridge/connect',
      { method: 'POST', body: assetId ? { pageId, pageName, assetId } : { pageId, pageName } },
    );
    revalidatePath('/pengaturan/facebook');
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.facebookBridge.failed };
  }
}

export async function disconnectFacebookBridge(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api('/v1/facebook-bridge/disconnect', { method: 'POST' });
    revalidatePath('/pengaturan/facebook');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.facebookBridge.failed };
  }
}

export async function connectInstagramBridge(_prev: IgBridgeResult | null, form: FormData): Promise<IgBridgeResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!username || !password) return { ok: false, error: t.instagramBridge.missingFields };

  try {
    const res = await api<{ status: 'ready' | 'challenge_required' | 'failed'; error?: string; challengeType?: IgBridgeResult['challengeType'] }>(
      '/v1/instagram-bridge/login', { method: 'POST', body: { username, password } },
    );
    revalidatePath('/pengaturan/instagram');
    if (res.status === 'failed') return { ok: false, error: res.error ?? t.instagramBridge.failed };
    return { ok: true, status: res.status, challengeType: res.challengeType };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramBridge.failed };
  }
}

/**
 * The third way in, and the only one that asks the operator for nothing.
 *
 * `connectInstagramBridge` wants a password and `connectInstagramBridgeWithCookie`
 * wants a `sessionid` copied out of DevTools by hand. This opens Instagram's own
 * login page in a browser window on the bridge's machine and lets the operator
 * log in there — so no Instagram credential is typed into the CRM at all, and
 * 2FA or a checkpoint is answered on Instagram's own screen instead of being
 * relayed through a code box here.
 *
 * Returns as soon as the window is open. The form polls for the rest.
 */
export async function openInstagramLoginWindow(_prev: IgBridgeResult | null, form: FormData): Promise<IgBridgeResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    const res = await api<{ status: 'awaiting_login' }>(
      '/v1/instagram-bridge/login-window', { method: 'POST' });
    revalidatePath('/pengaturan/instagram');
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramBridge.failed };
  }
}

export async function connectInstagramBridgeWithCookie(_prev: IgBridgeResult | null, form: FormData): Promise<IgBridgeResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const username = String(form.get('username') ?? '').trim();
  const sessionId = String(form.get('sessionId') ?? '').trim();
  const csrfToken = String(form.get('csrfToken') ?? '').trim();
  const dsUserId = String(form.get('dsUserId') ?? '').trim();
  if (!username || !sessionId) return { ok: false, error: t.instagramBridge.missingCookieFields };

  try {
    const res = await api<{ status: 'ready' | 'failed'; error?: string }>(
      '/v1/instagram-bridge/login-cookie', {
        method: 'POST',
        body: { username, sessionId, csrfToken: csrfToken || undefined, dsUserId: dsUserId || undefined },
      },
    );
    revalidatePath('/pengaturan/instagram');
    if (res.status === 'failed') return { ok: false, error: res.error ?? t.instagramBridge.failed };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramBridge.failed };
  }
}

export async function submitInstagramChallenge(_prev: IgBridgeResult | null, form: FormData): Promise<IgBridgeResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const code = String(form.get('code') ?? '').trim();
  if (!code) return { ok: false, error: t.instagramBridge.missingCode };

  try {
    const res = await api<{ status: 'ready' | 'challenge_required' | 'failed'; error?: string; challengeType?: IgBridgeResult['challengeType'] }>(
      '/v1/instagram-bridge/challenge', { method: 'POST', body: { code } },
    );
    revalidatePath('/pengaturan/instagram');
    if (res.status === 'failed') return { ok: false, error: res.error ?? t.instagramBridge.failed };
    return { ok: true, status: res.status, challengeType: res.challengeType };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramBridge.failed };
  }
}

export async function disconnectInstagramBridge(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api('/v1/instagram-bridge/disconnect', { method: 'POST' });
    revalidatePath('/pengaturan/instagram');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramBridge.failed };
  }
}

export async function connectInstagramMeta(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const accessToken = String(form.get('accessToken') ?? '').trim();
  if (!accessToken) return { ok: false, error: t.instagramMeta.missingToken };

  try {
    await api('/v1/instagram-meta/connect', { method: 'POST', body: { accessToken } });
    revalidatePath('/pengaturan/instagram');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramMeta.failed };
  }
}

export async function disconnectInstagramMeta(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api('/v1/instagram-meta/disconnect', { method: 'POST' });
    revalidatePath('/pengaturan/instagram');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.instagramMeta.failed };
  }
}

/* ------------------------------------------------------------ balasan cepat */

/** One action for both adding and editing — the presence of an id decides. */
export async function saveQuickReply(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }

  const id = String(form.get('id') ?? '');
  const payload = {
    title: String(form.get('title') ?? '').trim(),
    body: String(form.get('body') ?? '').trim(),
    shortcut: String(form.get('shortcut') ?? '').trim() || undefined,
  };
  if (!payload.title || !payload.body) return { ok: false, error: t.quickReply.failed };

  try {
    if (id) {
      await api(`/v1/quick-replies/${id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/v1/quick-replies', { method: 'POST', body: payload });
    }
    revalidatePath('/pengaturan/balasan-cepat');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.quickReply.failed };
  }
}

export async function removeQuickReply(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api(`/v1/quick-replies/${String(form.get('id') ?? '')}`, { method: 'DELETE' });
    revalidatePath('/pengaturan/balasan-cepat');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.quickReply.failed };
  }
}

/* -------------------------------------------------------------------- target */

/** One action for both adding and editing — the presence of an id decides. */
export async function saveSalesTarget(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }

  const id = String(form.get('id') ?? '');
  const ownerId = String(form.get('ownerId') ?? '').trim();
  const payload = {
    periodStart: String(form.get('periodStart') ?? '').trim(),
    periodEnd: String(form.get('periodEnd') ?? '').trim(),
    ownerId: ownerId || undefined,
    amountIdr: Number(form.get('amountIdr') ?? 0),
    notes: String(form.get('notes') ?? '').trim() || undefined,
  };
  if (!payload.periodStart || !payload.periodEnd || !payload.amountIdr) {
    return { ok: false, error: t.target.failed };
  }

  try {
    if (id) {
      await api(`/v1/sales-targets/${id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/v1/sales-targets', { method: 'POST', body: payload });
    }
    revalidatePath('/target');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.target.failed };
  }
}

export async function removeSalesTarget(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  try {
    await api(`/v1/sales-targets/${String(form.get('id') ?? '')}`, { method: 'DELETE' });
    revalidatePath('/target');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.target.failed };
  }
}

/* ------------------------------------------------------------- chat wa */

export async function createWaBridgeSession(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const displayName = String(form.get('displayName') ?? '').trim();
  if (!displayName) return { ok: false, error: t.waBridge.failed };

  try {
    await api('/v1/wa-bridge/channels', { method: 'POST', body: { displayName } });
    revalidatePath('/chat-wa', 'layout');
    revalidatePath('/channel-wa');
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.waBridge.failed };
  }
}

export async function disconnectWaBridgeSession(form: FormData): Promise<void> {
  await assertCsrf(form);
  const channelId = String(form.get('channelId') ?? '');
  await api(`/v1/wa-bridge/channels/${channelId}/disconnect`, { method: 'POST' });
  revalidatePath('/chat-wa', 'layout');
  revalidatePath('/channel-wa');
  revalidatePath('/', 'layout');
}

export async function deleteWaBridgeSession(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const channelId = String(form.get('channelId') ?? '');
  try {
    await api(`/v1/wa-bridge/channels/${channelId}`, { method: 'DELETE' });
    revalidatePath('/chat-wa', 'layout');
    revalidatePath('/channel-wa');
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.waBridge.failed };
  }
}

export async function reconnectWaBridgeSession(form: FormData): Promise<void> {
  await assertCsrf(form);
  const channelId = String(form.get('channelId') ?? '');
  await api(`/v1/wa-bridge/channels/${channelId}/reconnect`, { method: 'POST' });
  revalidatePath('/chat-wa', 'layout');
  revalidatePath('/channel-wa');
  revalidatePath('/', 'layout');
}

export async function saveWaBridgeMaxPerDay(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const channelId = String(form.get('channelId') ?? '');
  const maxPerDay = Number(form.get('maxPerDay') ?? NaN);
  if (!channelId || !Number.isFinite(maxPerDay) || maxPerDay < 0) {
    return { ok: false, error: t.waChannel.maxPerDayFailed };
  }

  try {
    await api(`/v1/wa-bridge/channels/${channelId}/limits`, { method: 'PATCH', body: { maxPerDay } });
    revalidatePath('/channel-wa');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.waChannel.maxPerDayFailed };
  }
}

export async function markInvoicePaidAction(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const reference = String(form.get('reference') ?? '').trim();
  if (!reference) return { ok: false, error: t.settings.invFailed };

  try {
    await api(`/v1/invoices/${id}/paid`, { method: 'POST', body: { reference } });
    revalidatePath('/pengaturan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.settings.invFailed };
  }
}

/* ---------------------------------------------------------------- broadcast */

export async function createBroadcastAction(
  _prev: ActionResult | null, form: FormData,
): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }

  const name = String(form.get('name') ?? '').trim();
  const templateId = String(form.get('templateId') ?? '');
  const channelId = String(form.get('channelId') ?? '');
  const tags = String(form.get('tags') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!name || !templateId || !channelId || tags.length === 0) {
    return { ok: false, error: t.broadcast.failed };
  }

  try {
    await api('/v1/broadcasts', { method: 'POST', body: { name, templateId, channelId, tags } });
    revalidatePath('/broadcast');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.broadcast.failed };
  }
}

/**
 * Called directly from `BroadcastDrawer` (not through `<form action>`) so the
 * segment size can refresh on every channel/tags change without a full submit
 * — same "plain async function, called by hand" shape as `addDocumentKind`.
 */
export async function previewBroadcast(
  channelId: string, tagsCsv: string,
): Promise<BroadcastPreview | null> {
  const tags = tagsCsv.split(',').map((v) => v.trim()).filter(Boolean);
  if (!channelId || tags.length === 0) return null;
  try {
    return await api<BroadcastPreview>(
      `/v1/broadcasts/preview?channelId=${encodeURIComponent(channelId)}&tags=${encodeURIComponent(tags.join(','))}`,
    );
  } catch {
    return null;
  }
}

/** Called from `BroadcastDetailDrawer` on open — same reasoning as `previewBroadcast`. */
export async function getBroadcastDetail(broadcastId: string): Promise<BroadcastDetail | null> {
  try {
    return await api<BroadcastDetail>(`/v1/broadcasts/${broadcastId}`);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- google calendar */

export async function disconnectGoogleCalendar(form: FormData): Promise<void> {
  await assertCsrf(form);
  await api('/v1/google-calendar/disconnect', { method: 'POST' });
  revalidatePath('/tugas');
}

/** The "Kirim Email" dialog on a pulled-in Google Calendar event — same shape as `sendMeetingEmail`, just no task behind it. */
export async function sendCalendarEventEmail(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const to = String(form.get('to') ?? '').trim();
  const eventId = String(form.get('eventId') ?? '');
  const title = String(form.get('title') ?? '');
  const start = String(form.get('start') ?? '');
  const meetingLink = String(form.get('meetingLink') ?? '').trim() || null;
  if (!to) return { ok: false, error: t.tasks.sendEmailFailed };

  try {
    await api('/v1/google-calendar/send-email', { method: 'POST', body: { to, eventId, title, start, meetingLink } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.tasks.sendEmailFailed };
  }
}

/**
 * What an agent did about one Instagram comment.
 *
 * Deliberately a record of a human's action, not a send: the public reply is
 * posted by the agent in Instagram itself, and this is where they say so.
 * Nothing here talks to Instagram — see docs on the Komentar IG page for why
 * posting publicly is the one step left to a person for now.
 */
export async function recordCommentOutcome(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('commentId') ?? '');
  const publicStatus = String(form.get('publicStatus') ?? 'sent') as 'sent' | 'skipped';
  await api(`/v1/ig-comments/${id}`, {
    method: 'PATCH',
    body: { publicStatus, ...(publicStatus === 'skipped' ? { dmStatus: 'skipped' } : {}) },
  });
  revalidatePath('/komentar-ig');
}
