import { t } from './copy';

export interface BrandImportRow {
  name: string;
  picName?: string;
  phone?: string;
  email?: string;
  instagram?: string;
  website?: string;
  category?: string;
  city?: string;
  source?: 'scrape' | 'manual' | 'referral' | 'other';
}

type MappedField = keyof BrandImportRow;

// A spreadsheet someone else built rarely uses this app's own field names —
// this maps whatever header they actually typed (Indonesian or English,
// with or without spaces) onto the field it means.
const HEADER_ALIASES: Record<string, MappedField> = {
  nama: 'name', 'nama brand': 'name', name: 'name', brand: 'name',
  pic: 'picName', 'nama pic': 'picName', picname: 'picName', 'contact person': 'picName',
  telepon: 'phone', 'no whatsapp': 'phone', 'no hp': 'phone', nomor: 'phone', phone: 'phone', whatsapp: 'phone',
  email: 'email',
  instagram: 'instagram', ig: 'instagram',
  website: 'website', web: 'website',
  kategori: 'category', category: 'category',
  kota: 'city', city: 'city',
  sumber: 'source', source: 'source',
};

const VALID_SOURCES = new Set(['scrape', 'manual', 'referral', 'other']);

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

export interface ParsedBrandImport {
  rows: BrandImportRow[];
  /** 1-based spreadsheet row numbers (header counted) skipped for having no name. */
  skippedRows: number[];
}

/**
 * `xlsx` handles both real Excel files and plain CSV from the same
 * `ArrayBuffer`, so one upload input covers either without asking which kind
 * it is. Dynamically imported, same reasoning as the export side — it's a
 * sizeable library that only Brand Management ever needs.
 */
export async function parseBrandImportFile(file: File): Promise<ParsedBrandImport> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0] ?? ''];
  if (!sheet) return { rows: [], skippedRows: [] };

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const rows: BrandImportRow[] = [];
  const skippedRows: number[] = [];

  raw.forEach((record, i) => {
    const mapped: Partial<BrandImportRow> = {};
    for (const [key, value] of Object.entries(record)) {
      const field = HEADER_ALIASES[normalizeHeader(key)];
      if (!field) continue;
      const str = String(value ?? '').trim();
      if (!str) continue;
      if (field === 'source') {
        const s = str.toLowerCase();
        mapped.source = (VALID_SOURCES.has(s) ? s : 'scrape') as BrandImportRow['source'];
      } else {
        mapped[field] = str;
      }
    }
    // Row 1 is the header, so the first data row is spreadsheet row 2.
    if (!mapped.name) { skippedRows.push(i + 2); return; }
    rows.push(mapped as BrandImportRow);
  });

  return { rows, skippedRows };
}

export async function downloadBrandImportTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  const headers = [
    t.brandManagement.col.name, t.brandManagement.col.picName, t.brandManagement.col.phone,
    t.brandManagement.col.email, t.brandManagement.col.instagram, t.brandManagement.col.website,
    t.brandManagement.col.category, t.brandManagement.col.city, t.brandManagement.col.source,
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.brandManagement.templateSheetName);
  XLSX.writeFile(wb, 'template-import-brand.xlsx');
}
