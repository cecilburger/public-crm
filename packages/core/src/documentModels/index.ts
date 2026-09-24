/**
 * The pure half of the document model: types, page geometry and layout
 * defaults, shared by the API, the database package and (by mirroring) the
 * console.
 *
 * `generateDocumentDocx` used to live here. It moved to
 * `apps/api/src/documents/docxRenderer.ts` along with the rest of the
 * rendering, because producing a `.docx` needs the `docx` library and
 * `packages/core` is meant to hold rules with no dependencies beyond zod and
 * node:crypto — a rule the architecture test enforces and this file was
 * breaking.
 */
export type {
  DocumentKindOption, MergeField, DocumentLayoutElement, DocumentPageSize, DocumentPageSetup, RichTextNode,
  TextElement,
} from './standar.ts';
export {
  defaultDocumentLayout, PAGE_WIDTH_PX, PAGE_HEIGHT_PX, pageSizePx, DEFAULT_PAGE_SETUP,
  // Shared with the renderer in apps/api so a document's wording and a page's
  // geometry keep exactly one definition.
  TITLES, INTROS, PAGE_SIZES_MM, PX_TO_TWIP, PX_TO_EMU, mmToTwip, resolveText, imageTypeFromDataUrl,
} from './standar.ts';
