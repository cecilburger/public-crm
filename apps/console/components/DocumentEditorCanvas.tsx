'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import JSZip from 'jszip';
import Konva from 'konva';
import { Stage, Layer, Text as KonvaText, Image as KonvaImage, Rect, Group, Transformer } from 'react-konva';
import { useEditor, EditorContent, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { saveDocumentLayout } from '@/app/(app)/actions';
import { useCsrfToken } from '@/components/Csrf';
import { MergeFieldExtension } from '@/components/MergeFieldExtension';
import { t } from '@/lib/copy';
import type { DocRecord, DocumentLayoutElement, DocumentMergeField, DocumentPageSize, RichTextJson } from '@/lib/api';

// Mirrors `packages/core/src/documentModels/standar.ts` — console can't
// import a server package, same reasoning as `DocumentKindOption` elsewhere.
const PAGE_SIZES_MM: Record<DocumentPageSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  f4: { width: 215, height: 330 },
};
const MM_PER_INCH = 25.4;
const PX_PER_INCH = 96;
const mmToPx = (mm: number) => Math.round((mm / MM_PER_INCH) * PX_PER_INCH);
const pageSizePx = (size: DocumentPageSize) => {
  const mm = PAGE_SIZES_MM[size];
  return { width: mmToPx(mm.width), height: mmToPx(mm.height) };
};

type TextElement = Extract<DocumentLayoutElement, { type: 'text' }>;
type ImageElement = Extract<DocumentLayoutElement, { type: 'image' }>;
type RichTextElement = Extract<DocumentLayoutElement, { type: 'richtext' }>;

/** Plain-text preview for the canvas — formatting only really shows up in
 *  the side panel's Tiptap editor, this is just enough to recognise the block. */
function flattenRichText(node: RichTextJson): string {
  if (node.type === 'mergeField') {
    const field = node.attrs?.field as DocumentMergeField | undefined;
    return field ? `[${t.document.mergeFieldLabel[field]}]` : '';
  }
  if (node.text) return node.text;
  const joined = (node.content ?? []).map(flattenRichText).join(node.type === 'bulletList' ? '\n' : ' ');
  return node.type === 'listItem' ? `• ${joined}` : joined;
}

function displayText(el: TextElement): string {
  return el.content.kind === 'literal' ? el.content.text : `[${t.document.mergeFieldLabel[el.content.field]}]`;
}

/** Loads a data-URL as an `HTMLImageElement` for Konva to draw — avoids
 *  pulling in a separate image-loading package for one small hook. */
function useHtmlImage(src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const image = new window.Image();
    image.onload = () => setImg(image);
    image.src = src;
    return () => { image.onload = null; };
  }, [src]);
  return img;
}

function ImageShape({
  el, isSelected, onSelect, onChange, shapeRef,
}: {
  el: ImageElement; isSelected: boolean; onSelect: () => void;
  onChange: (patch: Partial<ImageElement>) => void; shapeRef: (node: Konva.Node | null) => void;
}) {
  const image = useHtmlImage(el.dataUrl);
  const onTransformEnd = (e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onChange({ x: node.x(), y: node.y(), w: Math.max(20, el.w * scaleX), h: Math.max(20, el.h * scaleY) });
  };

  if (!image) return <Rect x={el.x} y={el.y} width={el.w} height={el.h} dash={[4, 4]} stroke="#C9C7DD" />;

  return (
    <KonvaImage
      ref={shapeRef} image={image} x={el.x} y={el.y} width={el.w} height={el.h} draggable
      stroke={isSelected ? '#2F31A8' : undefined} strokeWidth={isSelected ? 2 : 0}
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
      onTransformEnd={onTransformEnd}
    />
  );
}

function TextShape({
  el, isSelected, onSelect, onChange, shapeRef,
}: {
  el: TextElement; isSelected: boolean; onSelect: () => void;
  onChange: (patch: Partial<TextElement>) => void; shapeRef: (node: Konva.Node | null) => void;
}) {
  const onTransformEnd = (e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onChange({ x: node.x(), y: node.y(), w: Math.max(20, el.w * scaleX), h: Math.max(16, el.h * scaleY) });
  };

  return (
    <KonvaText
      ref={shapeRef} text={displayText(el)} x={el.x} y={el.y} width={el.w} height={el.h}
      fontSize={el.fontSize} fontStyle={el.bold ? 'bold' : 'normal'} fill="#16183C" wrap="word" draggable
      stroke={isSelected ? '#2F31A8' : undefined} strokeWidth={isSelected ? 0.6 : 0}
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
      onTransformEnd={onTransformEnd}
    />
  );
}

function RichTextShape({
  el, isSelected, onSelect, onChange, shapeRef,
}: {
  el: RichTextElement; isSelected: boolean; onSelect: () => void;
  onChange: (patch: Partial<RichTextElement>) => void; shapeRef: (node: Konva.Node | null) => void;
}) {
  const preview = flattenRichText(el.content).slice(0, 400);
  const onTransformEnd = (e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onChange({ x: node.x(), y: node.y(), w: Math.max(40, el.w * scaleX), minHeight: Math.max(20, el.minHeight * scaleY) });
  };

  // A Group, not two separately-positioned nodes — the border and the
  // preview text drag/resize together as one unit instead of the border
  // lagging a frame behind during the gesture.
  return (
    <Group
      ref={shapeRef} x={el.x} y={el.y} draggable
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
      onTransformEnd={onTransformEnd}
    >
      <Rect width={el.w} height={el.minHeight}
            fill={isSelected ? 'rgba(47,49,168,0.05)' : undefined}
            stroke={isSelected ? '#2F31A8' : '#C9C7DD'} dash={isSelected ? undefined : [4, 4]} />
      <KonvaText text={preview || t.document.richTextPlaceholder} width={el.w} height={el.minHeight}
                 fontSize={11} fill={preview ? '#16183C' : '#8A8DAC'} wrap="word" padding={4} listening={false} />
    </Group>
  );
}

/** The rich-text editing surface itself — lives in the side panel, keyed by
 *  element id so switching the selected block always starts a fresh editor
 *  instance instead of needing to manually re-sync Tiptap's own state. */
function RichTextPanel({ element, onChange }: { element: RichTextElement; onChange: (content: RichTextJson) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, MergeFieldExtension],
    content: element.content as JSONContent,
    onUpdate: ({ editor: ed }) => onChange(ed.getJSON() as RichTextJson),
  });

  if (!editor) return null;

  return (
    <div className="doc-editor-tiptap">
      <div className="doc-editor-tiptap-toolbar">
        <button type="button" className={editor.isActive('bold') ? 'active' : ''}
                onClick={() => editor.chain().focus().toggleBold().run()} title={t.document.boldTip}>
          <b>B</b>
        </button>
        <button type="button" className={editor.isActive('italic') ? 'active' : ''}
                onClick={() => editor.chain().focus().toggleItalic().run()} title={t.document.italicTip}>
          <i>I</i>
        </button>
        <button type="button" className={editor.isActive('bulletList') ? 'active' : ''}
                onClick={() => editor.chain().focus().toggleBulletList().run()} title={t.document.bulletTip}>
          •≡
        </button>
        <button type="button" className={editor.isActive('heading', { level: 2 }) ? 'active' : ''}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title={t.document.headingTip}>
          H
        </button>
        <select className="line-input" value="" style={{ fontSize: 11.5 }}
                onChange={(e) => {
                  const field = e.target.value as DocumentMergeField | '';
                  if (field) editor.chain().focus().insertMergeField(field).run();
                  e.target.value = '';
                }}>
          <option value="">+ {t.document.insertMergeField}</option>
          {(['tenant_name', 'document_name'] as const).map((f) => (
            <option key={f} value={f}>{t.document.mergeFieldLabel[f]}</option>
          ))}
        </select>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * The customize step: drag/resize text and a logo on an A4-sized canvas,
 * saved as a plain positioned-element array that `renderDocumentLayout`
 * (packages/core) turns into the real `.docx` on download — what's shown
 * here and what Word opens use the same coordinates.
 */
export function DocumentEditorCanvas({ doc }: { doc: DocRecord }) {
  const csrf = useCsrfToken();
  const [elements, setElements] = useState<DocumentLayoutElement[]>(doc.layout ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ ok: boolean; error?: string } | null>(null);
  const [referenceImages, setReferenceImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState<DocumentPageSize>(doc.pageSize ?? 'a4');
  const [marginTop, setMarginTop] = useState(doc.marginTopMm ?? 25);
  const [marginRight, setMarginRight] = useState(doc.marginRightMm ?? 25);
  const [marginBottom, setMarginBottom] = useState(doc.marginBottomMm ?? 25);
  const [marginLeft, setMarginLeft] = useState(doc.marginLeftMm ?? 25);
  const { width: pageWidthPx, height: pageHeightPx } = pageSizePx(pageSize);
  const marginTopPx = mmToPx(marginTop);
  const marginRightPx = mmToPx(marginRight);
  const marginBottomPx = mmToPx(marginBottom);
  const marginLeftPx = mmToPx(marginLeft);

  const shapeRefs = useRef<Record<string, Konva.Node | null>>({});
  const trRef = useRef<Konva.Transformer>(null);

  useEffect(() => {
    const node = selectedId ? shapeRefs.current[selectedId] : null;
    if (node && trRef.current) {
      trRef.current.nodes([node]);
      trRef.current.getLayer()?.batchDraw();
    } else {
      trRef.current?.nodes([]);
    }
  }, [selectedId, elements]);

  const selected = elements.find((el) => el.id === selectedId) ?? null;

  const updateElement = (id: string, patch: Record<string, unknown>) => {
    setElements((prev) => prev.map((el) => (el.id === id ? ({ ...el, ...patch } as DocumentLayoutElement) : el)));
  };

  const removeSelected = () => {
    if (!selected) return;
    setElements((prev) => prev.filter((el) => el.id !== selected.id));
    setSelectedId(null);
  };

  const addText = () => {
    const id = crypto.randomUUID();
    setElements((prev) => [...prev, {
      id, type: 'text', x: 60, y: 60, w: 300, h: 30, fontSize: 12, bold: false,
      content: { kind: 'literal', text: 'Teks baru' },
    }]);
    setSelectedId(id);
  };

  const addImage = (dataUrl: string) => {
    const id = crypto.randomUUID();
    setElements((prev) => [...prev, { id, type: 'image', x: 60, y: 300, w: 140, h: 80, dataUrl }]);
    setSelectedId(id);
  };

  const addRichText = () => {
    const id = crypto.randomUUID();
    setElements((prev) => [...prev, {
      id, type: 'richtext', x: 60, y: 400, w: 400, minHeight: 60,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    }]);
    setSelectedId(id);
  };

  const onLogoFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const onImageReplaceFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selected) return;
    const reader = new FileReader();
    reader.onload = () => updateElement(selected.id, { dataUrl: reader.result as string });
    reader.readAsDataURL(file);
  };

  const onReferenceFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setReferenceError(null);
    setReferenceImages([]);
    try {
      const zip = await JSZip.loadAsync(file);
      const mediaFiles = Object.values(zip.files).filter(
        (f) => !f.dir && /^word\/media\/.+\.(png|jpe?g|gif|bmp)$/i.test(f.name),
      );
      if (mediaFiles.length === 0) {
        setReferenceError(t.document.uploadReferenceEmpty);
        return;
      }
      const images = await Promise.all(mediaFiles.map(async (f) => {
        const base64 = await f.async('base64');
        const ext = f.name.split('.').pop()!.toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return { name: f.name, dataUrl: `data:image/${mime};base64,${base64}` };
      }));
      setReferenceImages(images);
    } catch {
      setReferenceError(t.document.uploadReferenceFailed);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveState(null);
    const fd = new FormData();
    fd.set('csrf', csrf);
    fd.set('documentId', doc.id);
    fd.set('layout', JSON.stringify(elements));
    fd.set('pageSize', pageSize);
    fd.set('marginTopMm', String(marginTop));
    fd.set('marginRightMm', String(marginRight));
    fd.set('marginBottomMm', String(marginBottom));
    fd.set('marginLeftMm', String(marginLeft));
    const res = await saveDocumentLayout(fd);
    setSaveState(res);
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="doc-editor-toolbar">
        <Link href="/customize/dokumen" className="btn ghost sm">{t.document.backToDetail}</Link>
        <h2 style={{ fontSize: 14, marginRight: 'auto' }}>{doc.name}</h2>
        <button type="button" className="btn ghost sm" onClick={addText}>+ {t.document.addText}</button>
        <button type="button" className="btn ghost sm" onClick={addRichText}>+ {t.document.addRichText}</button>
        <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
          + {t.document.addLogo}
          <input type="file" accept="image/*" onChange={onLogoFile} style={{ display: 'none' }} />
        </label>
        <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
          {t.document.uploadReference}
          <input type="file" accept=".docx" onChange={onReferenceFile} style={{ display: 'none' }} />
        </label>
        <button type="button" className="btn primary sm" onClick={handleSave} disabled={saving}>
          {saving ? t.document.saving : t.document.save}
        </button>
        {saveState ? (
          <span className={saveState.ok ? 'chip good' : 'chip danger'}>
            {saveState.ok ? t.document.editorSaved : (saveState.error ?? t.document.editorFailed)}
          </span>
        ) : null}
      </div>

      {referenceImages.length > 0 || referenceError ? (
        <div className="doc-editor-toolbar" style={{ borderTop: 'none' }}>
          <span className="dim" style={{ fontSize: 12 }}>{t.document.uploadReferenceHint}</span>
          {referenceError ? <span className="error" style={{ fontSize: 12 }}>{referenceError}</span> : null}
          <div className="doc-editor-refs">
            {referenceImages.map((img) => (
              <img key={img.name} src={img.dataUrl} alt="" className="doc-editor-ref-thumb"
                   onClick={() => addImage(img.dataUrl)} title={img.name} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="doc-editor-body">
        <div className="doc-editor-stage-wrap">
          <Stage
            width={pageWidthPx} height={pageHeightPx}
            onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelectedId(null); }}
          >
            <Layer>
              <Rect x={marginLeftPx} y={marginTopPx}
                    width={Math.max(0, pageWidthPx - marginLeftPx - marginRightPx)}
                    height={Math.max(0, pageHeightPx - marginTopPx - marginBottomPx)}
                    stroke="#C9C7DD" dash={[4, 4]} listening={false} />
              {elements.map((el) => (
                el.type === 'image' ? (
                  <ImageShape key={el.id} el={el} isSelected={el.id === selectedId}
                              onSelect={() => setSelectedId(el.id)}
                              onChange={(patch) => updateElement(el.id, patch)}
                              shapeRef={(node) => { shapeRefs.current[el.id] = node; }} />
                ) : el.type === 'richtext' ? (
                  <RichTextShape key={el.id} el={el} isSelected={el.id === selectedId}
                                 onSelect={() => setSelectedId(el.id)}
                                 onChange={(patch) => updateElement(el.id, patch)}
                                 shapeRef={(node) => { shapeRefs.current[el.id] = node; }} />
                ) : (
                  <TextShape key={el.id} el={el} isSelected={el.id === selectedId}
                             onSelect={() => setSelectedId(el.id)}
                             onChange={(patch) => updateElement(el.id, patch)}
                             shapeRef={(node) => { shapeRefs.current[el.id] = node; }} />
                )
              ))}
              <Transformer ref={trRef} rotateEnabled={false} keepRatio={false}
                           boundBoxFunc={(oldBox, newBox) => (newBox.width < 20 || newBox.height < 16 ? oldBox : newBox)} />
            </Layer>
          </Stage>
        </div>

        <div className="doc-editor-panel">
          <div className="doc-editor-page-setup">
            <h3 style={{ fontSize: 12.5, marginBottom: 10 }}>{t.document.pageSetup}</h3>
            <div className="record-field">
              <label>{t.document.pageSize}</label>
              <select className="line-input" value={pageSize}
                      onChange={(e) => setPageSize(e.target.value as DocumentPageSize)}>
                {(['a4', 'letter', 'legal', 'f4'] as const).map((size) => (
                  <option key={size} value={size}>{t.document.pageSizeLabel[size]}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="record-field">
                <label>{t.document.marginTop} ({t.document.marginUnit})</label>
                <input className="line-input" type="number" min={0} max={100} value={marginTop}
                       onChange={(e) => setMarginTop(Number(e.target.value) || 0)} />
              </div>
              <div className="record-field">
                <label>{t.document.marginRight} ({t.document.marginUnit})</label>
                <input className="line-input" type="number" min={0} max={100} value={marginRight}
                       onChange={(e) => setMarginRight(Number(e.target.value) || 0)} />
              </div>
              <div className="record-field">
                <label>{t.document.marginBottom} ({t.document.marginUnit})</label>
                <input className="line-input" type="number" min={0} max={100} value={marginBottom}
                       onChange={(e) => setMarginBottom(Number(e.target.value) || 0)} />
              </div>
              <div className="record-field">
                <label>{t.document.marginLeft} ({t.document.marginUnit})</label>
                <input className="line-input" type="number" min={0} max={100} value={marginLeft}
                       onChange={(e) => setMarginLeft(Number(e.target.value) || 0)} />
              </div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          {selected?.type === 'text' ? (
            <>
              <div className="record-field">
                <label>{t.document.fixedText} / {t.document.autoData}</label>
                <select className="line-input" value={selected.content.kind}
                        onChange={(e) => updateElement(selected.id, {
                          content: e.target.value === 'literal'
                            ? { kind: 'literal', text: selected.content.kind === 'literal' ? selected.content.text : '' }
                            : { kind: 'field', field: 'tenant_name' as DocumentMergeField },
                        })}>
                  <option value="literal">{t.document.fixedText}</option>
                  <option value="field">{t.document.autoData}</option>
                </select>
              </div>
              {selected.content.kind === 'literal' ? (
                <div className="record-field">
                  <textarea className="line-input" rows={3} value={selected.content.text}
                            onChange={(e) => updateElement(selected.id, { content: { kind: 'literal', text: e.target.value } })} />
                </div>
              ) : (
                <div className="record-field">
                  <select className="line-input" value={selected.content.field}
                          onChange={(e) => updateElement(selected.id, {
                            content: { kind: 'field', field: e.target.value as DocumentMergeField },
                          })}>
                    {(['tenant_name', 'document_name'] as const).map((f) => (
                      <option key={f} value={f}>{t.document.mergeFieldLabel[f]}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="record-field">
                <label>{t.document.fontSize}</label>
                <input className="line-input" type="number" min={8} max={72} value={selected.fontSize}
                       onChange={(e) => updateElement(selected.id, { fontSize: Number(e.target.value) || selected.fontSize })} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginBottom: 14 }}>
                <input type="checkbox" checked={selected.bold}
                       onChange={(e) => updateElement(selected.id, { bold: e.target.checked })} />
                {t.document.bold}
              </label>
            </>
          ) : null}

          {selected?.type === 'image' ? (
            <div className="record-field">
              <label>{t.document.addLogo}</label>
              <input type="file" accept="image/*" onChange={onImageReplaceFile} />
            </div>
          ) : null}

          {selected?.type === 'richtext' ? (
            <RichTextPanel key={selected.id} element={selected}
                           onChange={(content) => updateElement(selected.id, { content })} />
          ) : null}

          {selected ? (
            <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={removeSelected}>
              {t.document.removeElement}
            </button>
          ) : (
            <p className="dim" style={{ fontSize: 12.5 }}>{t.document.selectElementHint}</p>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
