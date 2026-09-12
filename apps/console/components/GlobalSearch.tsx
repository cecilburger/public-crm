'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/lib/copy';
import type { SearchResult } from '@/app/api/search/route';

const CATEGORY_ORDER: SearchResult['category'][] = ['contact', 'deal', 'order', 'task', 'brand'];

/**
 * One box, every entity — Ctrl+K from anywhere in the console, or the
 * trigger in the rail. Results come from `/api/search`, which reuses the
 * same list endpoints each page already calls (see that route for why).
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Ctrl+K / Cmd+K opens the palette from anywhere — the one shortcut this
  // app has, so it doesn't need to fight any page for the key.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced fetch — the query changes on every keystroke, the request shouldn't.
  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json() as { results: SearchResult[] };
        setResults(data.results);
        setActiveIndex(0);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const select = (r: SearchResult) => {
    setOpen(false);
    router.push(r.href);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter' && results[activeIndex]) { e.preventDefault(); select(results[activeIndex]); }
  };

  const grouped = CATEGORY_ORDER
    .map((cat) => ({ cat, items: results.filter((r) => r.category === cat) }))
    .filter((g) => g.items.length > 0);

  let flatIndex = -1;

  return (
    <>
      <button type="button" className="gsearch-trigger" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
        </svg>
        {t.search.trigger}
        <span className="gsearch-shortcut">{t.search.shortcut}</span>
      </button>

      {open ? (
        <div className="gsearch-overlay">
          <div className="gsearch-panel" ref={rootRef}>
            <div className="gsearch-input-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input ref={inputRef} className="gsearch-input" value={query}
                     onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKeyDown}
                     placeholder={t.search.placeholder} aria-label={t.search.placeholder} />
              <button type="button" className="gsearch-close" onClick={() => setOpen(false)} aria-label="Close">Esc</button>
            </div>

            <div className="gsearch-results">
              {!query.trim() ? (
                <p className="gsearch-empty">{t.search.hint}</p>
              ) : loading ? null : results.length === 0 ? (
                <p className="gsearch-empty">{t.search.empty(query.trim())}</p>
              ) : (
                grouped.map((g) => (
                  <div key={g.cat} className="gsearch-group">
                    <div className="gsearch-group-label">{t.search.categoryLabel[g.cat]}</div>
                    {g.items.map((r) => {
                      flatIndex += 1;
                      const idx = flatIndex;
                      return (
                        <button type="button" key={`${r.category}-${r.id}`}
                                className={`gsearch-item ${idx === activeIndex ? 'active' : ''}`}
                                onMouseEnter={() => setActiveIndex(idx)}
                                onClick={() => select(r)}>
                          <b>{r.title}</b>
                          {r.subtitle ? <span className="dim">{r.subtitle}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
