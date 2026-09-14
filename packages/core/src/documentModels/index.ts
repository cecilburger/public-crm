import { buildStandarDocument, renderDocumentLayout, type DocumentLayoutElement } from './standar.ts';

export type { DocumentKindOption, MergeField, DocumentLayoutElement } from './standar.ts';
export { defaultDocumentLayout, PAGE_WIDTH_PX, PAGE_HEIGHT_PX } from './standar.ts';

/**
 * One entry point regardless of which model a document picked. `model` is
 * free text (a tenant can add their own on top of "Standar") but only one
 * generator exists — a custom name is just a label until a second one is
 * built. Once a document has a saved layout (every document created after
 * this feature shipped does), that layout is authoritative; `buildStandarDocument`
 * only serves documents from before it existed.
 */
export async function generateDocumentDocx(args: {
  model: string; kind: string; tenantName: string; documentName: string; layout: DocumentLayoutElement[] | null;
}): Promise<Buffer> {
  const { layout, ...rest } = args;
  if (layout && layout.length > 0) return renderDocumentLayout({ ...rest, layout });
  return buildStandarDocument(rest);
}
