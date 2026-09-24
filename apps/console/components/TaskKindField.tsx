'use client';

import { useState } from 'react';
import { addTaskKind } from '@/app/(app)/actions';
import { useCsrfToken } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { TaskKind } from '@/lib/api';

const BUILTIN = ['follow_up', 'call', 'meeting', 'chat', 'email'] as const;

/**
 * The Jenis select, plus an inline "+ Tambah Jenis Baru" — picking it swaps
 * the select for a name field and a plus button, right where "Lainnya" sits
 * at the bottom of the list. Controlled (`value`/`onChange`) because the
 * parent form still needs to know when the kind becomes "meeting" to show
 * the video-conference field.
 */
export function TaskKindField({
  id, name, value, onChange, initialCustomKinds,
}: {
  id: string; name: string; value: string; onChange: (v: string) => void; initialCustomKinds: TaskKind[];
}) {
  const csrf = useCsrfToken();
  const [customKinds, setCustomKinds] = useState<Pick<TaskKind, 'id' | 'name'>[]>(initialCustomKinds);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (v: string) => {
    if (v === '__add__') {
      setError(null);
      setAdding(true);
      return;
    }
    onChange(v);
  };

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('csrf', csrf);
      fd.set('name', trimmed);
      const res = await addTaskKind(fd);
      if (!res.ok || !res.kind) {
        setError(res.error ?? t.tasks.addKindFailed);
        return;
      }
      setCustomKinds((prev) => (prev.some((k) => k.id === res.kind!.id) ? prev : [...prev, res.kind!]));
      onChange(res.kind.name);
      setAdding(false);
      setNewName('');
    } finally {
      setPending(false);
    }
  };

  const cancelAdd = () => {
    setAdding(false);
    setNewName('');
    setError(null);
  };

  return (
    <div className="record-field">
      <label htmlFor={id}>{t.tasks.formKind}</label>
      <select className="line-input" id={id} value={adding ? '__add__' : value}
              onChange={(e) => handleSelect(e.target.value)}>
        {BUILTIN.map((k) => <option key={k} value={k}>{t.tasks.kindLabel[k]}</option>)}
        {customKinds.map((k) => <option key={k.id} value={k.name}>{k.name}</option>)}
        <option value="other">{t.tasks.kindLabel.other}</option>
        <option value="__add__">+ {t.tasks.addKind}</option>
      </select>

      {adding ? (
        <span style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <input className="line-input" value={newName} onChange={(e) => setNewName(e.target.value)}
                 placeholder={t.tasks.addKindPlaceholder} autoFocus
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }} />
          <button type="button" className="btn ghost sm" onClick={handleAdd} disabled={pending || !newName.trim()}
                  aria-label={t.tasks.addKind} title={t.tasks.addKind}>
            +
          </button>
          <button type="button" className="btn ghost sm" onClick={cancelAdd}>{t.document.discard}</button>
        </span>
      ) : null}
      {error ? <p className="error" style={{ fontSize: 11.5, marginTop: 4 }}>{error}</p> : null}

      <input type="hidden" name={name} value={value} />
    </div>
  );
}
