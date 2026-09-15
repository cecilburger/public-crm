import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound, generateDocumentDocx, type RichTextNode } from '@kirana/core';
import {
  listDocuments, getDocument, createDocument, updateDocument, updateDocumentLayout, deleteDocument,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

// Tiptap's own ProseMirror JSON — deeply validating its shape isn't worth it
// (the tenant is only ever writing their own document), but it still has to
// structurally match `RichTextNode` for `body.data.layout` to type-check
// against `DocumentLayoutElement[]` below, hence `z.lazy` for the recursion.
const richTextNode: z.ZodType<RichTextNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(richTextNode).optional(),
    text: z.string().optional(),
    marks: z.array(z.object({ type: z.string() })).optional(),
  }),
);

const documentBody = z.object({
  name: z.string().min(1).max(128),
  kind: z.string().min(1).max(60),
  model: z.string().min(1).max(60),
  useTemplate: z.boolean(),
});

const layoutElement = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(60), type: z.literal('text'),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    fontSize: z.number().positive().max(96), bold: z.boolean(),
    content: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('literal'), text: z.string().max(2000) }),
      z.object({ kind: z.literal('field'), field: z.enum(['tenant_name', 'document_name']) }),
    ]),
  }),
  z.object({
    id: z.string().min(1).max(60), type: z.literal('image'),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    dataUrl: z.string().max(6_000_000).startsWith('data:image/'),
  }),
  z.object({
    id: z.string().min(1).max(60), type: z.literal('richtext'),
    x: z.number(), y: z.number(), w: z.number().positive(), minHeight: z.number().positive(),
    content: richTextNode,
  }),
]);

const layoutBody = z.object({
  layout: z.array(layoutElement).max(200),
  pageSize: z.enum(['a4', 'letter', 'legal', 'f4']),
  marginTopMm: z.number().int().min(0).max(100),
  marginRightMm: z.number().int().min(0).max(100),
  marginBottomMm: z.number().int().min(0).max(100),
  marginLeftMm: z.number().int().min(0).max(100),
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Customize > Dokumen: named documents built from a fixed set of kinds, each
 * generated from code by its `model` (today just 'standar') rather than
 * uploaded by hand. Same tier as message templates and sales targets —
 * `autopilot:manage`, the permission this app already uses for "shapes what
 * the business sends out", held by supervisors and up.
 */
export function registerDocumentRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/documents', async (req) => {
    ctx.guard(req, 'autopilot:manage');
    return ctx.asTenant(req, (tx, actor) => listDocuments({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.get('/v1/documents/:id', async (req) => {
    ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const doc = await ctx.asTenant(req, (tx, actor) =>
      getDocument({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { documentId: id }));
    if (!doc) throw notFound('Document');
    return doc;
  });

  /**
   * Generates the .docx on demand rather than storing one — the body is code,
   * not data, so there is nothing to keep in sync once the model changes.
   */
  app.get('/v1/documents/:id/generate', async (req, reply) => {
    ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const result = await ctx.asTenant(req, async (tx, actor) => {
      const doc = await getDocument({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { documentId: id });
      if (!doc) return null;
      const tenant = await tx.query<{ name: string }>('select name from tenants where id = $1', [actor.tenantId]);
      return { doc, tenantName: tenant[0]?.name ?? '' };
    });
    if (!result) throw notFound('Document');

    const buffer = await generateDocumentDocx({
      model: result.doc.model, kind: result.doc.kind, layout: result.doc.layout,
      tenantName: result.tenantName, documentName: result.doc.name,
      pageSetup: {
        pageSize: result.doc.pageSize, marginTopMm: result.doc.marginTopMm, marginRightMm: result.doc.marginRightMm,
        marginBottomMm: result.doc.marginBottomMm, marginLeftMm: result.doc.marginLeftMm,
      },
    });

    return reply
      .header('content-type', DOCX_MIME)
      .header('content-disposition', `attachment; filename="${result.doc.name.replace(/"/g, '')}.docx"`)
      .send(buffer);
  });

  app.post('/v1/documents', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = documentBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the document fields');

    const created = await ctx.asTenant(req, (tx) =>
      createDocument({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { ...body.data, createdBy: actor.userId }));
    return reply.status(201).send(created);
  });

  app.patch('/v1/documents/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = documentBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the document fields');

    const ok = await ctx.asTenant(req, (tx) =>
      updateDocument({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, documentId: id, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Document');
    return { ok: true };
  });

  /**
   * Saved from the canvas editor. Its own route (not folded into the PATCH
   * above) since it's a different form — positioned elements, not
   * Nama/Jenis/Model — and can carry a few embedded logo images, so it gets
   * a raised body limit instead of the app-wide 1MB default.
   */
  app.patch('/v1/documents/:id/layout', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = layoutBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the layout');

    const ok = await ctx.asTenant(req, (tx) =>
      updateDocumentLayout({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        documentId: id, layout: body.data.layout, pageSize: body.data.pageSize,
        marginTopMm: body.data.marginTopMm, marginRightMm: body.data.marginRightMm,
        marginBottomMm: body.data.marginBottomMm, marginLeftMm: body.data.marginLeftMm,
        actorId: actor.userId,
      }));
    if (!ok) throw notFound('Document');
    return { ok: true };
  });

  app.delete('/v1/documents/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      deleteDocument({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { documentId: id, actorId: actor.userId }));
    if (!ok) throw notFound('Document');
    return { ok: true };
  });
}
