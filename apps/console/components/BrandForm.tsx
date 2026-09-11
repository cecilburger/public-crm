'use client';

import { useActionState, useRef } from 'react';
import Link from 'next/link';
import { createBrand, updateBrand, deleteBrand, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand, Member } from '@/lib/api';

const SOURCES = ['manual', 'scrape', 'referral', 'other'] as const;

/** One sheet, two callers: blank for `/brand/baru`, filled in for `/brand/[id]`. */
export function BrandForm({ brand, members }: { brand: Brand | null; members: Member[] }) {
  const action = brand ? updateBrand : createBrand;
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  // Same reasoning as the Pelanggan form: a masked number is never something
  // to save back as the real one, so the field is disabled rather than trusted.
  const phoneMasked = brand?.phone?.includes('•') ?? false;

  return (
    <>
      <form id="brand-form" action={formAction} className="odoo-form-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CsrfField />
        {brand ? <input type="hidden" name="id" value={brand.id} /> : null}

        <div className="odoo-control-panel">
          <div className="odoo-cp-top">
            <div className="odoo-cp-breadcrumb">
              <Link href="/brand" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
                {t.brand.title}
              </Link>
              <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
              <h1>{brand ? brand.name : t.brand.newBrand}</h1>
            </div>
          </div>
          <div className="odoo-cp-bottom">
            <div className="odoo-cp-actions">
              <button type="submit" className="btn primary" disabled={pending}>
                {pending ? t.brand.saving : t.brand.save}
              </button>
              <Link href="/brand" className="btn ghost">{t.brand.discard}</Link>
              {brand ? (
                <button type="button" className="btn ghost" style={{ color: 'var(--danger)' }}
                        onClick={() => deleteDialogRef.current?.showModal()}>
                  {t.brand.delete}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="main-content-area" style={{ padding: 16 }}>
          <div className="record-sheet" style={{ margin: '0 auto', width: '100%', maxWidth: 900, marginTop: 16 }}>
            <div className="record-grid">
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="name">{t.brand.name}</label>
                <input className="line-input" id="name" name="name" required
                       defaultValue={brand?.name ?? ''} placeholder={t.brand.namePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="picName">{t.brand.picName}</label>
                <input className="line-input" id="picName" name="picName"
                       defaultValue={brand?.picName ?? ''} placeholder={t.brand.picNamePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="phone">{t.brand.phone}</label>
                <input className="line-input" id="phone" name="phone" defaultValue={brand?.phone ?? ''}
                       placeholder="+62812xxxxxxx" disabled={phoneMasked} />
                {phoneMasked ? <p className="record-hint">{t.customers.phoneMaskedHint}</p> : null}
              </div>

              <div className="record-field">
                <label htmlFor="email">{t.brand.email}</label>
                <input className="line-input" id="email" name="email" type="email"
                       defaultValue={brand?.email ?? ''} placeholder="nama@brand.com" />
              </div>

              <div className="record-field">
                <label htmlFor="instagram">{t.brand.instagram}</label>
                <input className="line-input" id="instagram" name="instagram"
                       defaultValue={brand?.instagram ?? ''} placeholder={t.brand.instagramPlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="website">{t.brand.website}</label>
                <input className="line-input" id="website" name="website"
                       defaultValue={brand?.website ?? ''} placeholder="https://…" />
              </div>

              <div className="record-field">
                <label htmlFor="category">{t.brand.category}</label>
                <input className="line-input" id="category" name="category"
                       defaultValue={brand?.category ?? ''} placeholder={t.brand.categoryPlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="city">{t.brand.city}</label>
                <input className="line-input" id="city" name="city" defaultValue={brand?.city ?? ''} />
              </div>

              <div className="record-field">
                <label htmlFor="source">{t.brand.source}</label>
                <select className="line-input" id="source" name="source" defaultValue={brand?.source ?? 'manual'}>
                  {SOURCES.map((s) => <option key={s} value={s}>{t.brand.sourceLabel[s]}</option>)}
                </select>
                <p className="record-hint">{t.brand.sourceHint}</p>
              </div>

              <div className="record-field">
                <label htmlFor="assigneeId">{t.brand.assignee}</label>
                <select className="line-input" id="assigneeId" name="assigneeId" defaultValue={brand?.assigneeId ?? ''}>
                  <option value="">{t.brand.unassigned}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="notes">{t.brand.notes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={3}
                          defaultValue={brand?.notes ?? ''} placeholder={t.brand.notesPlaceholder} />
              </div>
            </div>

            {state?.error ? <p className="error" style={{ marginTop: 18 }}>{state.error}</p> : null}
          </div>
        </div>
      </form>

      {brand ? (
        <dialog ref={deleteDialogRef} className="modal">
          <header className="modal-head">
            <h2>{t.brand.deleteTitle}</h2>
            <button type="button" className="btn ghost sm" onClick={() => deleteDialogRef.current?.close()}>
              {t.brand.discard}
            </button>
          </header>
          <div className="modal-body">
            <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
              <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
              <span>{t.brand.deleteWarning(brand.name)}</span>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => deleteDialogRef.current?.close()}>
                {t.brand.discard}
              </button>
              <form action={deleteBrand}>
                <CsrfField />
                <input type="hidden" name="id" value={brand.id} />
                <button className="btn primary" type="submit"
                        style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                  {t.brand.deleteConfirm}
                </button>
              </form>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
