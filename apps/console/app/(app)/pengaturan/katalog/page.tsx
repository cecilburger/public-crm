import { api, type KnowledgeRow } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { CatalogueEditor } from '@/components/CatalogueEditor';

export const dynamic = 'force-dynamic';

export interface ShippingRate {
  id: string;
  area: string;
  cost_idr: number;
  eta_days: number;
}

export default async function CataloguePage() {
  const [items, shipping] = await Promise.all([
    api<KnowledgeRow[]>('/v1/knowledge'),
    api<ShippingRate[]>('/v1/shipping-rates').catch(() => [] as ShippingRate[]),
  ]);

  const active = items.filter((i) => i.active);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.catalogue.title}</h1>
          <p className="subtitle">{t.catalogue.subtitle}</p>
        </div>
        <span className="chip">{active.filter((i) => i.kind === 'product').length} {t.catalogue.products.toLowerCase()}</span>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <CatalogueEditor
          products={active.filter((i) => i.kind === 'product')}
          notes={active.filter((i) => i.kind !== 'product')}
          shipping={shipping}
        />
      </div>
    </>
  );
}
