import {
  AlignmentType, Document, HeadingLevel, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, TextRun,
  VerticalPositionRelativeFrom, FrameAnchorType, TextWrappingType,
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

export type DocumentLayoutElement =
  | {
      id: string; type: 'text'; x: number; y: number; w: number; h: number;
      fontSize: number; bold: boolean;
      content: { kind: 'literal'; text: string } | { kind: 'field'; field: MergeField };
    }
  | { id: string; type: 'image'; x: number; y: number; w: number; h: number; dataUrl: string };

/** A4 at 96dpi — fixed so canvas pixels and generated-docx positions always agree. */
export const PAGE_WIDTH_PX = 794;
export const PAGE_HEIGHT_PX = 1123;

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
      id: 'intro', type: 'text', x: 60, y: 220, w: PAGE_WIDTH_PX - 120, h: 60,
      fontSize: 11, bold: false, content: { kind: 'literal', text: intro },
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

/**
 * Renders a saved canvas layout straight into a real `.docx` using the
 * `docx` library's absolute-position frames (text) and floating images —
 * both support page-relative pixel-equivalent offsets, so what the canvas
 * shows and what Word opens land in the same place without a headless
 * browser or a PDF render pipeline.
 */
export async function renderDocumentLayout(args: {
  layout: DocumentLayoutElement[]; tenantName: string; documentName: string;
}): Promise<Buffer> {
  const children = args.layout.map((el) => {
    if (el.type === 'image') {
      const base64 = el.dataUrl.slice(el.dataUrl.indexOf(',') + 1);
      return new Paragraph({
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
      });
    }

    return new Paragraph({
      frame: {
        type: 'absolute',
        position: { x: Math.round(el.x * PX_TO_TWIP), y: Math.round(el.y * PX_TO_TWIP) },
        width: Math.round(el.w * PX_TO_TWIP),
        height: Math.round(el.h * PX_TO_TWIP),
        anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      },
      children: [new TextRun({ text: resolveText(el.content, args), bold: el.bold, size: el.fontSize * 2 })],
    });
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/**
 * The original fixed layout — kept only as a fallback for a document whose
 * `layout` is still `null` (rows from before this feature existed; every
 * document created after gets a real layout via `defaultDocumentLayout`).
 */
export async function buildStandarDocument(args: {
  tenantName: string; documentName: string; kind: string;
}): Promise<Buffer> {
  const title = TITLES[args.kind as DocumentKindOption] ?? TITLES.lainnya;
  const intro = INTROS[args.kind as DocumentKindOption] ?? INTROS.lainnya;
  const doc = new Document({
    sections: [{
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
