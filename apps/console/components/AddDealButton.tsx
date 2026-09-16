'use client';

import { useState } from 'react';
import type { Brand, Stage } from '@/lib/api';
import { t } from '@/lib/copy';
import { QuickAddDealDrawer } from '@/components/QuickAddDealDrawer';

/**
 * The "Tambah Deal" entry point in the Deal page's own navbar — separate from
 * the per-column "+" on the kanban board, so it works from List view too.
 * Drops the new deal in the first open (non-Won/Lost) stage.
 */
export function AddDealButton({
  stages, brands, className = 'btn primary',
}: { stages: Stage[]; brands: Brand[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const defaultStage = stages.find((s) => !s.is_won && !s.is_lost) ?? stages[0];

  return (
    <>
      <button type="button" className={className} disabled={!defaultStage} onClick={() => setOpen(true)}>
        {t.sales.add}
      </button>
      <QuickAddDealDrawer stageId={open ? defaultStage?.id ?? null : null} stageName={defaultStage?.name ?? ''}
                          brands={brands} onClose={() => setOpen(false)} />
    </>
  );
}
