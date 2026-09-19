import {
  AlignmentType, Document, HeadingLevel, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, TextRun,
  VerticalPositionRelativeFrom, FrameAnchorType, TextWrappingType, HeightRule, type ISectionPropertiesOptions,
} from 'docx';
import {
  DEFAULT_PAGE_SETUP, INTROS, PAGE_SIZES_MM, PX_TO_EMU, PX_TO_TWIP, TITLES,
  imageTypeFromDataUrl, mmToTwip, resolveText,
  type DocumentKindOption, type DocumentLayoutElement, type DocumentPageSetup,
  type MergeField, type RichTextNode, type TextElement,
} from '@kirana/core';

/**
 * Turning a saved document into a real `.docx`.
 *
 * This used to live in `packages/core`, where it was the one thing importing a
 * third-party library into a package that is supposed to be rules and nothing
 * else — the architecture test says so, and it was failing. It moved here
 * rather than anywhere else because `apps/api/src/routes/documents.ts` is its
 * only caller and always has been.
 *
 * Nothing about how a document renders changed in the move: the code below is
 * the same code, reading the same shared definitions from `@kirana/core`.
 */
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
  pageSetup: DocumentPageSetup;
}): Promise<Buffer> {
  const { layout, ...rest } = args;
  if (layout && layout.length > 0) return renderDocumentLayout({ ...rest, layout });
  return buildStandarDocument(rest);
}
