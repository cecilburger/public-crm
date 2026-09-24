/**
 * Document models: page geometry, layout defaults, and the merge-field rules.
 *
 * WHAT IS NOT HERE: rendering a `.docx`. That lived in this file until the
 * architecture test caught it — `packages/core` is meant to be rules with no
 * I/O and no dependencies beyond zod and node:crypto, and `docx` is neither.
 * The renderer moved to `apps/api/src/documents/docxRenderer.ts`, which is the
 * only thing that ever called it.
 *
 * The split left a handful of previously-private helpers exported (TITLES,
 * INTROS, PAGE_SIZES_MM, PX_TO_TWIP, PX_TO_EMU, mmToTwip, resolveText,
 * imageTypeFromDataUrl, TextElement). They are shared with that renderer
 * rather than duplicated into it, so the wording of a document and the
 * geometry of a page still have exactly one definition.
 */

/**
 * The four kinds built into the UI. Not the same type as
 * `packages/db/src/documents.ts`'s `kind` column — duplicated on purpose.
 * `packages/db` depends on `packages/core`, so core can't import the db
 * package's types back without a cycle; this enum is small and stable enough
 * that repeating it here is cheaper than untangling the dependency direction.
 * A tenant can also add a custom Jenis (see `document_kinds`), which arrives
 * here as a plain string outside this union — `TITLES`/`INTROS` fall back to
 * `lainnya`'s wording for those, same as any other kind with no coded layout.
 */
export type DocumentKindOption = 'penawaran' | 'invoice' | 'kwitansi' | 'lainnya';

export const TITLES: Record<DocumentKindOption, string> = {
  penawaran: 'SURAT PENAWARAN HARGA',
  invoice: 'INVOICE',
  kwitansi: 'KWITANSI',
  lainnya: 'DOKUMEN',
};

export const INTROS: Record<DocumentKindOption, string> = {
  penawaran: 'Dengan hormat, bersama ini kami sampaikan penawaran harga untuk kebutuhan Bapak/Ibu sebagai berikut:',
  invoice: 'Berikut kami sampaikan rincian tagihan sebagai berikut:',
  kwitansi: 'Telah diterima dari pelanggan pembayaran dengan rincian sebagai berikut:',
  lainnya: 'Bersama ini kami sampaikan dokumen berikut:',
};

/**
 * The only two values a standalone Dokumen record actually has today — no
 * document is tied to a specific customer/deal/order, so that's as far as
 * "dynamic" text can go until documents gain that link.
 */
export type MergeField = 'tenant_name' | 'document_name';

/**
 * A minimal structural mirror of Tiptap/ProseMirror's JSON document shape —
 * only what `renderRichTextParagraphs` below actually walks, not a re-import
 * of Tiptap's own types. Tiptap itself is a console-only, browser-only
 * dependency; this package never imports it, only interprets its JSON output.
 */
export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  text?: string;
  marks?: { type: string }[];
}

export type DocumentLayoutElement =
  | {
      id: string; type: 'text'; x: number; y: number; w: number; h: number;
      fontSize: number; bold: boolean;
      content: { kind: 'literal'; text: string } | { kind: 'field'; field: MergeField };
    }
  | {
      id: string; type: 'richtext'; x: number; y: number; w: number; minHeight: number;
      content: RichTextNode;
    }
  | { id: string; type: 'image'; x: number; y: number; w: number; h: number; dataUrl: string };

export type DocumentPageSize = 'a4' | 'letter' | 'legal' | 'f4';

export const PAGE_SIZES_MM: Record<DocumentPageSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  // Folio — the size most Indonesian official letters/invoices are still printed on.
  f4: { width: 215, height: 330 },
};

const MM_PER_INCH = 25.4;
const PX_PER_INCH = 96;
const TWIP_PER_INCH = 1440;

function mmToPx(mm: number): number { return Math.round((mm / MM_PER_INCH) * PX_PER_INCH); }
export function mmToTwip(mm: number): number { return Math.round((mm / MM_PER_INCH) * TWIP_PER_INCH); }

/**
 * A4 at 96dpi — every layout element's x/y/w/h is expressed against this one
 * fixed coordinate system regardless of which paper size a document ends up
 * generated on. Changing paper size only moves the page boundary and margin
 * guide drawn around those same coordinates in the editor; it doesn't
 * rescale the elements themselves (same reasoning Word uses — page setup and
 * content position are independent).
 */
export const PAGE_WIDTH_PX = mmToPx(PAGE_SIZES_MM.a4.width);
export const PAGE_HEIGHT_PX = mmToPx(PAGE_SIZES_MM.a4.height);

export function pageSizePx(pageSize: DocumentPageSize): { width: number; height: number } {
  const mm = PAGE_SIZES_MM[pageSize];
  return { width: mmToPx(mm.width), height: mmToPx(mm.height) };
}

export interface DocumentPageSetup {
  pageSize: DocumentPageSize;
  marginTopMm: number; marginRightMm: number; marginBottomMm: number; marginLeftMm: number;
}

/** Matches Word's own "Normal" preset — 2.54cm (1") on every side. */
export const DEFAULT_PAGE_SETUP: DocumentPageSetup = {
  pageSize: 'a4', marginTopMm: 25, marginRightMm: 25, marginBottomMm: 25, marginLeftMm: 25,
};

/**
 * The layout a new document starts with — arranged to read the same as the
 * old fixed template (`buildStandarDocument` below) so the very first
 * "Generate" click, before anyone has touched the canvas, already produces
 * something sensible instead of a blank page.
 */
export function defaultDocumentLayout(args: { kind: string; documentName: string }): DocumentLayoutElement[] {
  const title = TITLES[args.kind as DocumentKindOption] ?? TITLES.lainnya;
  const intro = INTROS[args.kind as DocumentKindOption] ?? INTROS.lainnya;
  return [
    {
      id: 'tenant-name', type: 'text', x: 60, y: 60, w: PAGE_WIDTH_PX - 120, h: 40,
      fontSize: 20, bold: true, content: { kind: 'field', field: 'tenant_name' },
    },
    {
      id: 'title', type: 'text', x: 60, y: 120, w: PAGE_WIDTH_PX - 120, h: 32,
      fontSize: 16, bold: true, content: { kind: 'literal', text: title },
    },
    {
      id: 'perihal', type: 'text', x: 60, y: 180, w: PAGE_WIDTH_PX - 120, h: 28,
      fontSize: 11, bold: true, content: { kind: 'field', field: 'document_name' },
    },
    {
      id: 'intro', type: 'richtext', x: 60, y: 220, w: PAGE_WIDTH_PX - 120, minHeight: 60,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: intro }] }] },
    },
  ];
}

export type TextElement = Extract<DocumentLayoutElement, { type: 'text' }>;

export function resolveText(content: TextElement['content'], args: { tenantName: string; documentName: string }): string {
  if (content.kind === 'literal') return content.text;
  return content.field === 'tenant_name' ? args.tenantName : args.documentName;
}

export const PX_TO_TWIP = 15; // 1440 twips/inch ÷ 96px/inch
export const PX_TO_EMU = 9525; // 914400 EMU/inch ÷ 96px/inch

export function imageTypeFromDataUrl(dataUrl: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const match = /^data:image\/(png|jpeg|jpg|gif|bmp)/i.exec(dataUrl);
  const kind = match?.[1]?.toLowerCase();
  if (kind === 'jpeg') return 'jpg';
  return (kind as 'png' | 'jpg' | 'gif' | 'bmp' | undefined) ?? 'png';
}
