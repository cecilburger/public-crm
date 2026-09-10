import { api, type Contact } from '@/lib/api';
import { ago, initials } from '@/lib/format';
import { t } from '@/lib/copy';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const contacts = await api<Contact[]>('/v1/contacts');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.customers.title}</h1>
          <p className="subtitle">{t.customers.subtitle}</p>
        </div>
        <span className="chip">{contacts.length} {t.customers.title.toLowerCase()}</span>
      </div>

      <div className="scroll pad stack">
        <div className="panel">
          {contacts.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.customers.noCustomers}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t.customers.name}</th>
                  <th>{t.customers.phone}</th>
                  <th>{t.customers.tags}</th>
                  <th className="num">{t.customers.lastSeen}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span className="avatar" aria-hidden>{initials(c.displayName)}</span>
                        <b>{c.displayName ?? c.phone ?? '—'}</b>
                      </span>
                    </td>
                    <td className="mono">{c.phone ?? '—'}</td>
                    <td>
                      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                      </span>
                    </td>
                    <td className="num">{ago(c.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
