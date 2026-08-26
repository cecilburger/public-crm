'use client';

import { useActionState } from 'react';
import {
  saveCatalogueItem, removeCatalogueItem, saveShippingRate, removeShippingRate,
  type ActionResult,
} from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import type { KnowledgeRow } from '@/lib/api';
import type { ShippingRate } from '@/app/(app)/pengaturan/katalog/page';

/**
 * Every row is its own form.
 *
 * Editing a price or a stock count is the thing a shop owner does daily, so it
 * happens in place — no modal, no separate edit screen, and it works with
 * JavaScript switched off.
 */
export function CatalogueEditor({
  products, notes, shipping,
}: { products: KnowledgeRow[]; notes: KnowledgeRow[]; shipping: ShippingRate[] }) {
  const [saved, save, saving] = useActionState<ActionResult | null, FormData>(saveCatalogueItem, null);
  const [, remove] = useActionState<ActionResult | null, FormData>(removeCatalogueItem, null);
  const [shipSaved, saveShip, savingShip] = useActionState<ActionResult | null, FormData>(saveShippingRate, null);
  const [, removeShip] = useActionState<ActionResult | null, FormData>(removeShippingRate, null);

  return (
    <>
      <div className="panel">
        <header>
          <h2>{t.catalogue.products}</h2>
          <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.catalogue.productsNote}</span>
        </header>

        <div className="body stack" style={{ gap: 10 }}>
          {saved?.error ? <p className="error">{saved.error}</p> : null}

          {products.length === 0 ? (
            <p className="dim" style={{ fontSize: 13 }}>{t.catalogue.emptyProducts}</p>
          ) : products.map((item) => (
            <form key={item.id} action={save} className="rowform">
              <CsrfField />
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="kind" value="product" />
              <label><span className="mono dim">{t.catalogue.name}</span>
                <input className="input" name="title" defaultValue={item.title} required /></label>
              <label style={{ maxWidth: 120 }}><span className="mono dim">{t.catalogue.sku}</span>
                <input className="input" name="sku" defaultValue={item.sku ?? ''} /></label>
              <label style={{ maxWidth: 130 }}><span className="mono dim">{t.catalogue.price}</span>
                <input className="input" name="priceIdr" inputMode="numeric"
                       defaultValue={item.price_idr ?? ''} /></label>
              <label style={{ maxWidth: 90 }}><span className="mono dim">{t.catalogue.stock}</span>
                <input className="input" name="stock" inputMode="numeric"
                       defaultValue={item.stock ?? 0} /></label>
              <button className="btn sm" type="submit" disabled={saving}>{t.catalogue.save}</button>
              <button className="btn ghost sm" type="submit" formAction={remove}>{t.catalogue.remove}</button>
            </form>
          ))}

          <form action={save} className="rowform addrow">
            <CsrfField />
            <input type="hidden" name="kind" value="product" />
            <label><span className="mono dim">{t.catalogue.name}</span>
              <input className="input" name="title" placeholder="Kemeja Linen Pria" required /></label>
            <label style={{ maxWidth: 120 }}><span className="mono dim">{t.catalogue.sku}</span>
              <input className="input" name="sku" placeholder={t.catalogue.skuHint} /></label>
            <label style={{ maxWidth: 130 }}><span className="mono dim">{t.catalogue.price}</span>
              <input className="input" name="priceIdr" inputMode="numeric" placeholder="320000" /></label>
            <label style={{ maxWidth: 90 }}><span className="mono dim">{t.catalogue.stock}</span>
              <input className="input" name="stock" inputMode="numeric" placeholder="12" /></label>
            <button className="btn primary sm" type="submit" disabled={saving}>
              {saving ? t.catalogue.saving : t.catalogue.add}
            </button>
          </form>
        </div>
      </div>

      <div className="panel">
        <header>
          <h2>{t.catalogue.notes}</h2>
          <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.catalogue.notesNote}</span>
        </header>
        <div className="body stack" style={{ gap: 10 }}>
          {notes.length === 0 ? (
            <p className="dim" style={{ fontSize: 13 }}>{t.catalogue.emptyNotes}</p>
          ) : notes.map((item) => (
            <form key={item.id} action={save} className="rowform">
              <CsrfField />
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="kind" value={item.kind} />
              <label style={{ maxWidth: 200 }}><span className="mono dim">{t.catalogue.noteTitle}</span>
                <input className="input" name="title" defaultValue={item.title} required /></label>
              <label><span className="mono dim">{t.catalogue.noteBody}</span>
                <input className="input" name="body" defaultValue={item.body} /></label>
              <span className="chip">{item.kind === 'policy' ? t.catalogue.kindPolicy : t.catalogue.kindFaq}</span>
              <button className="btn sm" type="submit" disabled={saving}>{t.catalogue.save}</button>
              <button className="btn ghost sm" type="submit" formAction={remove}>{t.catalogue.remove}</button>
            </form>
          ))}

          <form action={save} className="rowform addrow">
            <CsrfField />
            <label style={{ maxWidth: 200 }}><span className="mono dim">{t.catalogue.noteTitle}</span>
              <input className="input" name="title" placeholder="Retur" required /></label>
            <label><span className="mono dim">{t.catalogue.noteBody}</span>
              <input className="input" name="body" placeholder="Retur maksimal 3 hari setelah barang diterima." /></label>
            <label style={{ maxWidth: 140 }}><span className="mono dim">{t.catalogue.kind}</span>
              <select className="input" name="kind" defaultValue="faq">
                <option value="faq">{t.catalogue.kindFaq}</option>
                <option value="policy">{t.catalogue.kindPolicy}</option>
              </select></label>
            <button className="btn primary sm" type="submit" disabled={saving}>{t.catalogue.addNote}</button>
          </form>
        </div>
      </div>

      <div className="panel">
        <header>
          <h2>{t.catalogue.shipping}</h2>
          <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.catalogue.shippingNote}</span>
        </header>
        <div className="body stack" style={{ gap: 10 }}>
          {shipSaved?.error ? <p className="error">{shipSaved.error}</p> : null}

          {shipping.length === 0 ? (
            <p className="dim" style={{ fontSize: 13 }}>{t.catalogue.emptyShipping}</p>
          ) : shipping.map((rate) => (
            <form key={rate.id} action={saveShip} className="rowform">
              <CsrfField />
              <input type="hidden" name="id" value={rate.id} />
              <label style={{ maxWidth: 200 }}><span className="mono dim">{t.catalogue.area}</span>
                <input className="input" name="area" defaultValue={rate.area} required /></label>
              <label style={{ maxWidth: 140 }}><span className="mono dim">{t.catalogue.cost}</span>
                <input className="input" name="costIdr" inputMode="numeric" defaultValue={rate.cost_idr} /></label>
              <label style={{ maxWidth: 110 }}><span className="mono dim">{t.catalogue.eta}</span>
                <input className="input" name="etaDays" inputMode="numeric" defaultValue={rate.eta_days} /></label>
              <span className="mono dim">{rp(rate.cost_idr)}</span>
              <button className="btn sm" type="submit" disabled={savingShip}>{t.catalogue.save}</button>
              <button className="btn ghost sm" type="submit" formAction={removeShip}>{t.catalogue.remove}</button>
            </form>
          ))}

          <form action={saveShip} className="rowform addrow">
            <CsrfField />
            <label style={{ maxWidth: 200 }}><span className="mono dim">{t.catalogue.area}</span>
              <input className="input" name="area" placeholder="Bekasi" required /></label>
            <label style={{ maxWidth: 140 }}><span className="mono dim">{t.catalogue.cost}</span>
              <input className="input" name="costIdr" inputMode="numeric" placeholder="12000" /></label>
            <label style={{ maxWidth: 110 }}><span className="mono dim">{t.catalogue.eta}</span>
              <input className="input" name="etaDays" inputMode="numeric" placeholder="2" /></label>
            <button className="btn primary sm" type="submit" disabled={savingShip}>{t.catalogue.save}</button>
          </form>
        </div>
      </div>
    </>
  );
}
