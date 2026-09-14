import type { Ctx } from './repo.ts';
import { audit } from './audit.ts';
import { defaultDocumentLayout, type DocumentLayoutElement } from '@kirana/core';

export interface DocumentRow {
  id: string; name: string;
  // Free text, not a closed union — a tenant can add its own "Jenis"/"Model"
  // values (see DocumentKind/DocumentModel) on top of the ones built into the UI.
  kind: string; model: string; useTemplate: boolean;
  layout: DocumentLayoutElement[] | null;
  createdBy: string | null; createdAt: Date; updatedAt: Date;
}

interface DocumentDbRow {
  id: string; name: string; kind: string; model: string; use_template: boolean;
  layout: DocumentLayoutElement[] | string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}

function mapRow(r: DocumentDbRow): DocumentRow {
  return {
    id: r.id, name: r.name, kind: r.kind, model: r.model, useTemplate: r.use_template,
    // jsonb comes back parsed from postgres-js but as a string from PGlite — same defensive read as audit.ts.
    layout: typeof r.layout === 'string' ? JSON.parse(r.layout) : r.layout,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, name, kind, model, use_template, layout, created_by, created_at, updated_at';

/** Every document on file, newest first — the Dokumen page's one query. */
export async function listDocuments(ctx: Ctx): Promise<DocumentRow[]> {
  const rows = await ctx.tx.query<DocumentDbRow>(
    `select ${COLUMNS} from documents where tenant_id = $1 order by created_at desc`,
    [ctx.tenantId],
  );
  return rows.map(mapRow);
}

export async function getDocument(ctx: Ctx, args: { documentId: string }): Promise<DocumentRow | null> {
  const rows = await ctx.tx.query<DocumentDbRow>(
    `select ${COLUMNS} from documents where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.documentId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createDocument(
  ctx: Ctx, args: { name: string; kind: string; model: string; useTemplate: boolean; createdBy: string },
): Promise<{ id: string }> {
  // Seeded so the very first "Generate" click already produces something
  // sensible — nobody has to open the layout editor just to get a blank page.
  const layout = defaultDocumentLayout({ kind: args.kind, documentName: args.name });
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into documents (tenant_id, name, kind, model, use_template, layout, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, args.name, args.kind, args.model, args.useTemplate, JSON.stringify(layout), args.createdBy],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'document.created',
    resourceType: 'document', resourceId: id, meta: { name: args.name, kind: args.kind },
  });
  return { id };
}

export async function updateDocument(
  ctx: Ctx,
  args: { documentId: string; name: string; kind: string; model: string; useTemplate: boolean; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update documents set name = $3, kind = $4, model = $5, use_template = $6, updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.documentId, args.name, args.kind, args.model, args.useTemplate],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'document.updated',
    resourceType: 'document', resourceId: args.documentId, meta: { name: args.name },
  });
  return true;
}

/**
 * Saved from the canvas editor, separate from `updateDocument` since it's a
 * different form entirely (Nama/Jenis/Model there vs. positioned elements
 * here) that shouldn't touch the other's fields.
 */
export async function updateDocumentLayout(
  ctx: Ctx, args: { documentId: string; layout: DocumentLayoutElement[]; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update documents set layout = $3, updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.documentId, JSON.stringify(args.layout)],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'document.layout_updated',
    resourceType: 'document', resourceId: args.documentId,
  });
  return true;
}

export async function deleteDocument(
  ctx: Ctx, args: { documentId: string; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `delete from documents where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.documentId],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'document.deleted',
    resourceType: 'document', resourceId: args.documentId,
  });
  return true;
}

export interface DocumentKindRow { id: string; name: string; createdAt: Date; }

/** Every custom "Jenis" a tenant has added, for the Dokumen form's dropdown. */
export async function listDocumentKinds(ctx: Ctx): Promise<DocumentKindRow[]> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `select id, name, created_at from document_kinds where tenant_id = $1 order by lower(name) asc`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

/** Adding the same name twice just hands back the existing row — a casual tag list, not a unique business record. */
export async function createDocumentKind(
  ctx: Ctx, args: { name: string; createdBy: string },
): Promise<DocumentKindRow> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `insert into document_kinds (tenant_id, name, created_by) values ($1,$2,$3)
     on conflict (tenant_id, lower(name)) do update set name = document_kinds.name
     returning id, name, created_at`,
    [ctx.tenantId, args.name, args.createdBy],
  );
  return { id: rows[0]!.id, name: rows[0]!.name, createdAt: rows[0]!.created_at };
}

export interface DocumentModelRow { id: string; name: string; createdAt: Date; }

/** Every custom "Model" a tenant has added, for the Dokumen form's dropdown. */
export async function listDocumentModels(ctx: Ctx): Promise<DocumentModelRow[]> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `select id, name, created_at from document_models where tenant_id = $1 order by lower(name) asc`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export async function createDocumentModel(
  ctx: Ctx, args: { name: string; createdBy: string },
): Promise<DocumentModelRow> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `insert into document_models (tenant_id, name, created_by) values ($1,$2,$3)
     on conflict (tenant_id, lower(name)) do update set name = document_models.name
     returning id, name, created_at`,
    [ctx.tenantId, args.name, args.createdBy],
  );
  return { id: rows[0]!.id, name: rows[0]!.name, createdAt: rows[0]!.created_at };
}
