import { t } from '@/lib/copy';
import { rp, initials } from '@/lib/format';
import { StatTile, BarList, type BarItem } from '@/components/DashboardWidgets';

// Everything on this page is placeholder data — there is no live query here.
// It exists so the shell of a dashboard (layout, stat tiles, ranked charts,
// a recent-activity table) has somewhere to live before it's wired to
// real aggregates.
const DAILY: BarItem[] = [
  { label: t.dashboard.days[0], value: 18 },
  { label: t.dashboard.days[1], value: 24 },
  { label: t.dashboard.days[2], value: 31 },
  { label: t.dashboard.days[3], value: 27 },
  { label: t.dashboard.days[4], value: 35 },
  { label: t.dashboard.days[5], value: 19 },
  { label: t.dashboard.days[6], value: 12 },
];

const CHANNELS: BarItem[] = [
  { label: t.channels.whatsapp, value: 86 },
  { label: t.channels.instagram, value: 22 },
  { label: t.channels.whatsapp_web, value: 14 },
  { label: t.channels.email, value: 6 },
];

const PIPELINE: BarItem[] = [
  { label: 'Baru', value: 3_150_000, display: rp(3_150_000) },
  { label: 'Berminat', value: 1_440_000, display: rp(1_440_000) },
  { label: 'Penawaran', value: 12_400_000, display: rp(12_400_000) },
  { label: 'Nego', value: 24_900_000, display: rp(24_900_000) },
  { label: 'Berhasil', value: 2_880_000, display: rp(2_880_000), tone: 'good' },
];

const RECENT = [
  { name: 'Bu Sari', phone: '+628123456789', tags: ['vip', 'customer'], when: '4m' },
  { name: 'Pak Hendra', phone: '+6281298765432', tags: ['korporat', 'customer'], when: '22m' },
  { name: 'Dinda Wardani', phone: '+6285712345678', tags: ['reseller', 'customer'], when: '2h' },
  { name: 'Toko Melati', phone: '+6281377788899', tags: ['grosir', 'customer'], when: '5h' },
  { name: 'Bu Ratna', phone: '+6287811223344', tags: ['baru', 'customer'], when: '1d' },
];

export const dynamic = 'force-static';

export default function DashboardPage() {
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.dashboard.title}</h1>
          <p className="subtitle">{t.dashboard.subtitle}</p>
        </div>
        <span className="spacer" />
        <span className="chip">{t.dashboard.dummyNote}</span>
      </div>

      <div className="scroll pad stack">
        <div className="grid c4">
          <StatTile label={t.dashboard.statCustomers} value="128" delta={t.dashboard.statCustomersDelta} direction="up" />
          <StatTile label={t.dashboard.statUnanswered} value="7" delta={t.dashboard.statUnansweredDelta} direction="down" />
          <StatTile label={t.dashboard.statSales} value={rp(42_500_000)} delta={t.dashboard.statSalesDelta} direction="up" />
          <StatTile label={t.dashboard.statReplyTime} value="6 menit" delta={t.dashboard.statReplyTimeDelta} direction="down" />
        </div>

        <div className="grid c3">
          <div className="panel">
            <header><h2>{t.dashboard.panelDaily}</h2></header>
            <div className="body"><BarList items={DAILY} /></div>
          </div>
          <div className="panel">
            <header><h2>{t.dashboard.panelChannels}</h2></header>
            <div className="body"><BarList items={CHANNELS} /></div>
          </div>
          <div className="panel">
            <header><h2>{t.dashboard.panelPipeline}</h2></header>
            <div className="body"><BarList items={PIPELINE} /></div>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t.dashboard.panelRecent}</h2></header>
          <table className="odoo-table">
            <thead>
              <tr>
                <th>{t.dashboard.tableName}</th>
                <th>{t.dashboard.tablePhone}</th>
                <th>{t.dashboard.tableTag}</th>
                <th className="num">{t.dashboard.tableWhen}</th>
              </tr>
            </thead>
            <tbody>
              {RECENT.map((c) => (
                <tr key={c.phone}>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="avatar" aria-hidden>{initials(c.name)}</span>
                      <b>{c.name}</b>
                    </span>
                  </td>
                  <td className="mono">{c.phone}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                    </span>
                  </td>
                  <td className="num">{c.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
