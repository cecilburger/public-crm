'use client';

import { useState } from 'react';
import { addDocumentModel } from '@/app/(app)/actions';
import { useCsrfToken } from '@/components/Csrf';
import { t } from '@/lib/copy';
import type { DocumentModel } from '@/lib/api';

const BUILTIN = ['standar'] as const;

/**
 * The Model select, plus an inline "+ Tambah Model Baru" — same shape as
 * `DocumentKindField`/`TaskKindField`.
 */
export function DocumentModelField({
  id, name, value, onChange, initialCustomModels,
}: {
  id: string; name: string; value: string; onChange: (v: string) => void; initialCustomModels: DocumentModel[];
}) {
  const csrf = useCsrfToken();
  const [customModels, setCustomModels] = useState(initialCustomModels);
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
      const res = await addDocumentModel(fd);
      if (!res.ok || !res.model) {
        setError(res.error ?? t.document.addModelFailed);
        return;
      }
      setCustomModels((prev) => (prev.some((m) => m.id === res.model!.id) ? prev : [...prev, res.model!]));
      onChange(res.model.name);
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
      <label htmlFor={id}>{t.document.model}</label>
      <select className="line-input" id={id} value={adding ? '__add__' : value}
              onChange={(e) => handleSelect(e.target.value)}>
        {BUILTIN.map((m) => <option key={m} value={m}>{t.document.modelLabel[m]}</option>)}
        {customModels.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
        <option value="__add__">+ {t.document.addModel}</option>
      </select>

      {adding ? (
        <span style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <input className="line-input" value={newName} onChange={(e) => setNewName(e.target.value)}
                 placeholder={t.document.addModelPlaceholder} autoFocus
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }} />
          <button type="button" className="btn ghost sm" onClick={handleAdd} disabled={pending || !newName.trim()}
                  aria-label={t.document.addModel} title={t.document.addModel}>
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
