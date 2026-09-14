'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import JSZip from 'jszip';
import Konva from 'konva';
import { Stage, Layer, Text as KonvaText, Image as KonvaImage, Rect, Transformer } from 'react-konva';
import { saveDocumentLayout } from '@/app/(app)/actions';
import { useCsrfToken } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { DocRecord, DocumentLayoutElement, DocumentMergeField } from '@/lib/api';

const PAGE_WIDTH_PX = 794;
const PAGE_HEIGHT_PX = 1123;

type TextElement = Extract<DocumentLayoutElement, { type: 'text' }>;
type ImageElement = Extract<DocumentLayoutElement, { type: 'image' }>;

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
            width={PAGE_WIDTH_PX} height={PAGE_HEIGHT_PX}
            onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelectedId(null); }}
          >
            <Layer>
              {elements.map((el) => (
                el.type === 'image' ? (
                  <ImageShape key={el.id} el={el} isSelected={el.id === selectedId}
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
  );
}
