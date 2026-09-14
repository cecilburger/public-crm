import { t } from './copy';
import type { Brand, Member } from './api';

/**
 * `xlsx` is a sizeable library and this is the only place in the console
 * that needs it — dynamically imported here so it's its own chunk, loaded
 * only when someone actually clicks Export, not on every page that renders
 * the Brand table.
 */
export async function exportBrandsToExcel(brands: Brand[], members: Member[]): Promise<void> {
  const XLSX = await import('xlsx');
  const names = new Map(members.map((m) => [m.id, m.name]));

  const rows = brands.map((b) => ({
    [t.brand.exportColName]: b.name,
    [t.brand.exportColPic]: b.picName ?? '',
    [t.brand.exportColPhone]: b.phone ?? '',
    [t.brand.exportColEmail]: b.email ?? '',
    [t.brand.exportColInstagram]: b.instagram ?? '',
    [t.brand.exportColCategory]: b.category ?? '',
    [t.brand.exportColCity]: b.city ?? '',
    [t.brand.exportColSource]: t.brand.sourceLabel[b.source],
    [t.brand.exportColStatus]: t.brand.statusLabel[b.status],
    [t.brand.exportColAssignee]: b.assigneeId ? (names.get(b.assigneeId) ?? '') : '',
    [t.brand.exportColLastContacted]: b.lastContactedAt ? new Date(b.lastContactedAt).toLocaleString('id-ID') : '',
    [t.brand.exportColCreated]: new Date(b.createdAt).toLocaleString('id-ID'),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.brand.exportSheetName);
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `brand-${stamp}.xlsx`);
}
