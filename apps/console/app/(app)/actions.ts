'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { t } from '@/lib/copy';
import { assertCsrf, CsrfError } from '@/lib/csrf';

export interface ActionResult {
  ok: boolean;
  error?: string;
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

export async function markAsCustomer(form: FormData): Promise<void> {
  await assertCsrf(form);
  const conversationId = String(form.get('conversationId') ?? '');
  await api(`/v1/conversations/${conversationId}/mark-customer`, { method: 'POST' });
  revalidatePath('/chat-wa', 'layout');
  revalidatePath('/pelanggan');
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

export async function createTask(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const contactId = String(form.get('contactId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const dueAt = String(form.get('dueAt') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  const dealId = String(form.get('dealId') ?? '').trim();
  const assigneeId = String(form.get('assigneeId') ?? '').trim();

  if (!contactId || !title || !dueAt) return { ok: false, error: t.tasks.failed };

  try {
    await api('/v1/tasks', {
      method: 'POST',
      body: {
        contactId, title, dueAt,
        notes: notes || undefined, dealId: dealId || undefined, assigneeId: assigneeId || undefined,
      },
    });
    revalidatePath('/tugas');
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
  const contactId = String(form.get('contactId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  const dueAt = String(form.get('dueAt') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  const dealId = String(form.get('dealId') ?? '').trim();
  const assigneeId = String(form.get('assigneeId') ?? '').trim();

  if (!contactId || !title || !dueAt) return { ok: false, error: t.tasks.failed };

  try {
    await api('/v1/tasks', {
      method: 'POST',
      body: {
        contactId, title, dueAt,
        notes: notes || undefined, dealId: dealId || undefined, assigneeId: assigneeId || undefined,
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

/* ------------------------------------------------------------- pelanggan */

function readCustomerForm(form: FormData) {
  const displayName = String(form.get('displayName') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const tags = String(form.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const address = String(form.get('address') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  return { displayName, phone, email, tags, address, notes };
}

export async function createCustomer(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const { displayName, phone, email, tags, address, notes } = readCustomerForm(form);

  let created: { id: string };
  try {
    created = await api<{ id: string }>('/v1/contacts', {
      method: 'POST',
      body: {
        ...(displayName ? { displayName } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(address ? { address } : {}),
        ...(notes ? { notes } : {}),
        tags,
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.customers.failed };
  }
  revalidatePath('/pelanggan');
  redirect(`/pelanggan/${created.id}`);
}

export async function updateCustomer(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const { displayName, phone, email, tags, address, notes } = readCustomerForm(form);

  try {
    await api(`/v1/contacts/${id}`, {
      method: 'PATCH',
      body: {
        displayName: displayName || null, phone: phone || null, email: email || null,
        address: address || null, notes: notes || null, tags,
      },
    });
    revalidatePath('/pelanggan');
    revalidatePath(`/pelanggan/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.customers.failed };
  }
}

export async function deleteCustomer(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  await api(`/v1/contacts/${id}`, { method: 'DELETE' });
  revalidatePath('/pelanggan');
  redirect('/pelanggan');
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

export async function deleteBrand(form: FormData): Promise<void> {
  await assertCsrf(form);
  const id = String(form.get('id') ?? '');
  await api(`/v1/brands/${id}`, { method: 'DELETE' });
  revalidatePath('/brand');
  redirect('/brand');
}

export async function moveDeal(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const dealId = String(form.get('dealId') ?? '');
  const stageId = String(form.get('stageId') ?? '');
  try {
    await api(`/v1/deals/${dealId}`, { method: 'PATCH', body: { stageId } });
    revalidatePath('/penjualan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.sales.moveFailed };
  }
}

export async function updateDealDetails(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const id = String(form.get('id') ?? '');
  const notes = String(form.get('notes') ?? '').trim();
  const expectedCloseOn = String(form.get('expectedCloseOn') ?? '').trim();

  try {
    await api(`/v1/deals/${id}/details`, {
      method: 'PATCH',
      body: { notes: notes || null, expectedCloseOn: expectedCloseOn || null },
    });
    revalidatePath(`/penjualan/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t.dealDetail.failed };
  }
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
    revalidatePath('/pengaturan/channel-wa');
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
  revalidatePath('/pengaturan/channel-wa');
  revalidatePath('/', 'layout');
}

export async function deleteWaBridgeSession(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try { await assertCsrf(form); } catch { return { ok: false, error: new CsrfError().message }; }
  const channelId = String(form.get('channelId') ?? '');
  try {
    await api(`/v1/wa-bridge/channels/${channelId}`, { method: 'DELETE' });
    revalidatePath('/chat-wa', 'layout');
    revalidatePath('/pengaturan/channel-wa');
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
  revalidatePath('/pengaturan/channel-wa');
  revalidatePath('/', 'layout');
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
