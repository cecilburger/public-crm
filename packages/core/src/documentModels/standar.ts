import {
  AlignmentType, Document, HeadingLevel, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, TextRun,
  VerticalPositionRelativeFrom, FrameAnchorType, TextWrappingType, HeightRule, type ISectionPropertiesOptions,
} from 'docx';

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

const TITLES: Record<DocumentKindOption, string> = {
  penawaran: 'SURAT PENAWARAN HARGA',
  invoice: 'INVOICE',
  kwitansi: 'KWITANSI',
  lainnya: 'DOKUMEN',
};

const INTROS: Record<DocumentKindOption, string> = {
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

const PAGE_SIZES_MM: Record<DocumentPageSize, { width: number; height: number }> = {
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
function mmToTwip(mm: number): number { return Math.round((mm / MM_PER_INCH) * TWIP_PER_INCH); }

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

type TextElement = Extract<DocumentLayoutElement, { type: 'text' }>;

function resolveText(content: TextElement['content'], args: { tenantName: string; documentName: string }): string {
  if (content.kind === 'literal') return content.text;
  return content.field === 'tenant_name' ? args.tenantName : args.documentName;
}

const PX_TO_TWIP = 15; // 1440 twips/inch ÷ 96px/inch
const PX_TO_EMU = 9525; // 914400 EMU/inch ÷ 96px/inch

function imageTypeFromDataUrl(dataUrl: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const match = /^data:image\/(png|jpeg|jpg|gif|bmp)/i.exec(dataUrl);
  const kind = match?.[1]?.toLowerCase();
  if (kind === 'jpeg') return 'jpg';
  return (kind as 'png' | 'jpg' | 'gif' | 'bmp' | undefined) ?? 'png';
}

function pageSectionProperties(setup: DocumentPageSetup): ISectionPropertiesOptions {
  const mm = PAGE_SIZES_MM[setup.pageSize];
  return {
    page: {
      size: { width: mmToTwip(mm.width), height: mmToTwip(mm.height) },
      margin: {
        top: mmToTwip(setup.marginTopMm), right: mmToTwip(setup.marginRightMm),
        bottom: mmToTwip(setup.marginBottomMm), left: mmToTwip(setup.marginLeftMm),
      },
    },
  };
}

function resolveField(field: MergeField, args: { tenantName: string; documentName: string }): string {
  return field === 'tenant_name' ? args.tenantName : args.documentName;
}

/** Inline content (plain text runs + our custom merge-field atom) → TextRuns. */
function inlineRuns(nodes: RichTextNode[] | undefined, args: { tenantName: string; documentName: string }): TextRun[] {
  if (!nodes) return [];
  return nodes.map((node) => {
    if (node.type === 'mergeField') {
      const field = node.attrs?.field as MergeField | undefined;
      return new TextRun({ text: field ? resolveField(field, args) : '' });
    }
    const marks = new Set((node.marks ?? []).map((m) => m.type));
    return new TextRun({ text: node.text ?? '', bold: marks.has('bold'), italics: marks.has('italic') });
  });
}

/**
 * Walks a Tiptap/ProseMirror JSON document into a flat list of `docx`
 * Paragraphs, every one sharing the same absolute `frame` — position/width
 * fixed, but `height` is only a minimum (`rule: HeightRule.ATLEAST`). Word
 * groups consecutively-framed paragraphs into one continuous frame that
 * grows to fit, so a long paragraph or an extra bullet makes the frame
 * taller instead of overflowing a fixed box the way a plain `'text'`
 * element would.
 */
function renderRichTextParagraphs(
  node: RichTextNode, args: { tenantName: string; documentName: string },
  frame: { x: number; y: number; w: number; minHeight: number },
): Paragraph[] {
  const framePr = {
    type: 'absolute' as const,
    position: { x: Math.round(frame.x * PX_TO_TWIP), y: Math.round(frame.y * PX_TO_TWIP) },
    width: Math.round(frame.w * PX_TO_TWIP),
    height: Math.round(frame.minHeight * PX_TO_TWIP),
    rule: HeightRule.ATLEAST,
    anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
  };

  const paragraphs: Paragraph[] = [];
  for (const block of node.content ?? []) {
    if (block.type === 'bulletList') {
      for (const item of block.content ?? []) {
        for (const itemBlock of item.content ?? []) {
          paragraphs.push(new Paragraph({ frame: framePr, bullet: { level: 0 }, children: inlineRuns(itemBlock.content, args) }));
        }
      }
      continue;
    }
    if (block.type === 'heading') {
      const level = Number(block.attrs?.level) || 1;
      const heading = level <= 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      paragraphs.push(new Paragraph({ frame: framePr, heading, children: inlineRuns(block.content, args) }));
      continue;
    }
    // paragraph, and anything else unrecognised — treated as plain text.
    paragraphs.push(new Paragraph({ frame: framePr, children: inlineRuns(block.content, args) }));
  }
  return paragraphs.length > 0 ? paragraphs : [new Paragraph({ frame: framePr, children: [] })];
}

/**
 * Renders a saved canvas layout straight into a real `.docx` using the
 * `docx` library's absolute-position frames (text) and floating images —
 * both support page-relative pixel-equivalent offsets, so what the canvas
 * shows and what Word opens land in the same place without a headless
 * browser or a PDF render pipeline.
 */
export async function renderDocumentLayout(args: {
  layout: DocumentLayoutElement[]; tenantName: string; documentName: string; pageSetup: DocumentPageSetup;
}): Promise<Buffer> {
  const children: Paragraph[] = [];
  for (const el of args.layout) {
    if (el.type === 'image') {
      const base64 = el.dataUrl.slice(el.dataUrl.indexOf(',') + 1);
      children.push(new Paragraph({
        children: [
          new ImageRun({
            type: imageTypeFromDataUrl(el.dataUrl),
            data: Buffer.from(base64, 'base64'),
            transformation: { width: el.w, height: el.h },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(el.x * PX_TO_EMU) },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(el.y * PX_TO_EMU) },
              wrap: { type: TextWrappingType.NONE },
            },
          }),
        ],
      }));
      continue;
    }

    if (el.type === 'richtext') {
      children.push(...renderRichTextParagraphs(el.content, args, { x: el.x, y: el.y, w: el.w, minHeight: el.minHeight }));
      continue;
    }

    children.push(new Paragraph({
      frame: {
        type: 'absolute',
        position: { x: Math.round(el.x * PX_TO_TWIP), y: Math.round(el.y * PX_TO_TWIP) },
        width: Math.round(el.w * PX_TO_TWIP),
        height: Math.round(el.h * PX_TO_TWIP),
        anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      },
      children: [new TextRun({ text: resolveText(el.content, args), bold: el.bold, size: el.fontSize * 2 })],
    }));
  }

  const pageSection = pageSectionProperties(args.pageSetup);
  const doc = new Document({ sections: [{ properties: pageSection, children }] });
  return Packer.toBuffer(doc);
}

/**
 * The original fixed layout — kept only as a fallback for a document whose
 * `layout` is still `null` (rows from before this feature existed; every
 * document created after gets a real layout via `defaultDocumentLayout`).
 */
export async function buildStandarDocument(args: {
  tenantName: string; documentName: string; kind: string; pageSetup?: DocumentPageSetup;
}): Promise<Buffer> {
  const title = TITLES[args.kind as DocumentKindOption] ?? TITLES.lainnya;
  const intro = INTROS[args.kind as DocumentKindOption] ?? INTROS.lainnya;
  const pageSection = pageSectionProperties(args.pageSetup ?? DEFAULT_PAGE_SETUP);
  const doc = new Document({
    sections: [{
      properties: pageSection,
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: args.tenantName.toUpperCase(), bold: true, size: 32, color: '2F31A8' })],
        }),
        new Paragraph({ text: '' }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: title, bold: true })],
        }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun({ text: `Perihal: ${args.documentName}`, bold: true })] }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: intro }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '[Rincian item akan ditambahkan di sini]' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ alignment: AlignmentType.RIGHT, text: 'Hormat kami,' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: args.tenantName, bold: true })],
        }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}
