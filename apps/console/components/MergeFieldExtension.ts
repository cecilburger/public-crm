import { Node, mergeAttributes } from '@tiptap/core';
import { t } from '@/lib/copy';
import type { DocumentMergeField } from '@/lib/api';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mergeField: {
      insertMergeField: (field: DocumentMergeField) => ReturnType;
    };
  }
}

/**
 * An atomic inline chip — "Nama Toko"/"Nama Dokumen" dropped straight into a
 * sentence, resolved server-side the same way `resolveText()` already
 * resolves a plain `'text'` element bound to a merge field
 * (`packages/core/src/documentModels/standar.ts`). Not editable itself, just
 * selectable/deletable as one unit, same as any other atom node.
 */
export const MergeFieldExtension = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      field: { default: 'tenant_name' as DocumentMergeField },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-merge-field]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const field = node.attrs.field as DocumentMergeField;
    const label = t.document.mergeFieldLabel[field] ?? field;
    return ['span', mergeAttributes(HTMLAttributes, { 'data-merge-field': field, class: 'merge-field-chip' }), label];
  },

  addCommands() {
    return {
      insertMergeField: (field: DocumentMergeField) => ({ commands }) =>
        commands.insertContent({ type: this.name, attrs: { field } }),
    };
  },
});
