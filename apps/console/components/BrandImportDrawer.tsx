'use client';

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { importBrands, type ImportBrandsResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { parseBrandImportFile, downloadBrandImportTemplate, type BrandImportRow } from '@/lib/brandImport';

const PREVIEW_LIMIT = 10;

/**
 * The "Import Brand" navbar button opens this — same slide-in drawer chrome
 * as everywhere else in the app (Tambah Deal, Tambah Tugas). Upload, preview,
 * and the result summary all live inside it, so the toolbar itself stays a
 * single button rather than a standing panel.
 */
export function BrandImportDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ImportBrandsResult | null, FormData>(importBrands, null);
  const [rows, setRows] = useState<BrandImportRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<number[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDismissed(true);
    setFileName(file.name);
    setParsing(true);
    setParseError(null);
    try {
      const parsed = await parseBrandImportFile(file);
      setRows(parsed.rows);
      setSkippedRows(parsed.skippedRows);
    } catch {
      setRows([]);
      setSkippedRows([]);
      setParseError(t.brandManagement.parseFailed);
    } finally {
      setParsing(false);
    }
  };

  const showResult = state?.ok && !dismissed;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.brandManagement.importTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.brandManagement.importTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 16 }}>{t.brandManagement.importHint}</p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
            <button type="button" className="btn ghost" onClick={() => void downloadBrandImportTemplate()}>
              {t.brandManagement.downloadTemplate}
            </button>
            <label className="btn ghost" style={{ cursor: 'pointer' }}>
              {fileName ? t.brandManagement.changeFile : t.brandManagement.chooseFile}
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
                     onChange={(e) => void onFileChange(e)} />
            </label>
          </div>
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 16 }}>{fileName ?? t.brandManagement.noFileChosen}</p>

          {parsing ? <p className="dim">{t.brandManagement.parsing}</p> : null}
          {parseError ? <p className="error">{parseError}</p> : null}

          {!parsing && fileName && !parseError && rows.length === 0 && skippedRows.length === 0 ? (
            <p className="error">{t.brandManagement.noRows}</p>
          ) : null}

          {!parsing && rows.length > 0 ? (
            <>
              <p style={{ fontWeight: 600, marginBottom: 8 }}>{t.brandManagement.previewTitle(rows.length)}</p>
              <div style={{ overflowX: 'auto', marginBottom: 8 }}>
                <table className="odoo-table">
                  <thead>
                    <tr>
                      <th>{t.brandManagement.col.name}</th>
                      <th>{t.brandManagement.col.phone}</th>
                      <th>{t.brandManagement.col.category}</th>
                      <th>{t.brandManagement.col.source}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
                      <tr key={i}>
                        <td>{r.name}</td>
                        <td className="mono">{r.phone ?? '—'}</td>
                        <td className="dim">{r.category ?? '—'}</td>
                        <td className="dim">{r.source ? t.brand.sourceLabel[r.source] : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > PREVIEW_LIMIT ? (
                <p className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
                  {t.brandManagement.previewMore(rows.length - PREVIEW_LIMIT)}
                </p>
              ) : null}
            </>
          ) : null}

          {!parsing && skippedRows.length > 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 8 }}>
              {t.brandManagement.skippedTitle(skippedRows.length)}
              {' — '}{skippedRows.map((n) => t.brandManagement.rowLabel(n)).join(', ')}
            </p>
          ) : null}

          {state?.error && !dismissed ? <p className="error" style={{ marginTop: 12 }}>{state.error}</p> : null}

          {showResult ? (
            <div className="notice" style={{ marginTop: 14, background: 'var(--good-soft)', borderColor: 'var(--good)' }}>
              <span>
                {t.brandManagement.importResultCreated(state?.created ?? 0)}
                {state?.skipped && state.skipped.length > 0
                  ? t.brandManagement.importResultSkippedByServer(state.skipped.length) : ''}
              </span>
            </div>
          ) : null}

          {showResult ? (
            <button type="button" className="btn ghost" style={{ marginTop: 10 }}
                    onClick={() => fileInputRef.current?.click()}>
              {t.brandManagement.startOver}
            </button>
          ) : null}
        </div>

        {rows.length > 0 ? (
          <form action={formAction} onSubmit={() => setDismissed(false)} className="drawer-foot">
            <CsrfField />
            <input type="hidden" name="rows" value={JSON.stringify(rows)} />
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.brandManagement.importing : t.brandManagement.importButton(rows.length)}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.brand.discard}</button>
          </form>
        ) : null}
      </div>
    </>
  );
}
