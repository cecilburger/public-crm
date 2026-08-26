import { api, type Me, type Member } from '@/lib/api';
import { ago, initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { InviteForm } from '@/components/InviteForm';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const [me, members] = await Promise.all([api<Me>('/v1/me'), api<Member[]>('/v1/members')]);
  const canManage = me.user.role === 'owner' || me.user.role === 'admin';

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.team.title}</h1>
          <p className="subtitle">{t.team.subtitle}</p>
        </div>
        <span className="chip">{members.length} {t.team.people}</span>
      </div>

      <div className="scroll pad stack">
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>{t.team.person}</th><th>{t.team.role}</th>
                <th>{t.team.whatTheyCanDo}</th><th className="num">{t.team.lastSeen}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="avatar" aria-hidden>{initials(m.name)}</span>
                      <span>
                        <b>{m.name}</b>
                        {m.id === me.user.id ? <span className="chip" style={{ marginLeft: 7 }}>{t.team.you}</span> : null}
                        <br /><span className="mono dim">{m.email}</span>
                      </span>
                    </span>
                  </td>
                  <td><span className={`chip ${m.role === 'owner' ? 'brand' : ''}`}>{t.roles[m.role] ?? m.role}</span></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{t.roleNote[m.role]}</td>
                  <td className="num">{ago(m.last_login_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage ? <InviteForm /> : <p className="mono dim">{t.team.onlyAdmin}</p>}
      </div>
    </>
  );
}
