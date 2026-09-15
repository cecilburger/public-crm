'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createBroadcastAction, previewBroadcast, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { BroadcastChannel, BroadcastPreview, MessageTemplate } from '@/lib/api';

/** A quick-add panel that slides in from the right, same shape as `DocumentDrawer`. */
export function BroadcastDrawer({
  open, onClose, channels, templates,
}: { open: boolean; onClose: () => void; channels: BroadcastChannel[]; templates: MessageTemplate[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createBroadcastAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setTags('');
      setPreview(null);
      onClose();
    }
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounced live preview — refetches whenever the channel or tags change.
  useEffect(() => {
    if (!open || !channelId || !tags.trim()) { setPreview(null); return; }
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await previewBroadcast(channelId, tags);
        setPreview(result);
      } finally {
        setPreviewLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [channelId, tags, open]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.broadcast.add} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.broadcast.add}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.broadcast.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form ref={formRef} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label htmlFor="b-name">{t.broadcast.name}</label>
                <input className="line-input" id="b-name" name="name" required
                       placeholder={t.broadcast.namePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="b-channel">{t.broadcast.channel}</label>
                <select className="line-input" id="b-channel" name="channelId" value={channelId}
                        onChange={(e) => setChannelId(e.target.value)} required>
                  {channels.length === 0 ? <option value="">{t.broadcast.chooseChannel}</option> : null}
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.displayName}{c.phoneE164 ? ` (${c.phoneE164})` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="b-template">{t.broadcast.template}</label>
                {templates.length === 0 ? (
                  <p className="record-hint">{t.broadcast.templateEmpty}</p>
                ) : (
                  <select className="line-input" id="b-template" name="templateId" required defaultValue="">
                    <option value="" disabled>{t.broadcast.chooseTemplate}</option>
                    {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
                  </select>
                )}
              </div>

              <div className="record-field">
                <label htmlFor="b-tags">{t.broadcast.tags}</label>
                <input className="line-input" id="b-tags" name="tags" value={tags}
                       onChange={(e) => setTags(e.target.value)}
                       placeholder={t.broadcast.tagsPlaceholder} required />
                <p className="record-hint">{t.broadcast.tagsHint}</p>
              </div>

              {tags.trim() && channelId ? (
                <div className="record-field">
                  {previewLoading ? (
                    <p className="dim" style={{ fontSize: 13 }}>…</p>
                  ) : preview ? (
                    <div className="stack" style={{ gap: 2 }}>
                      <p style={{ fontSize: 13 }}>{t.broadcast.previewEligible(preview.eligible)}</p>
                      {preview.noConsent > 0 ? (
                        <p className="dim" style={{ fontSize: 12 }}>{t.broadcast.previewNoConsent(preview.noConsent)}</p>
                      ) : null}
                      {preview.noConversation > 0 ? (
                        <p className="dim" style={{ fontSize: 12 }}>{t.broadcast.previewNoConversation(preview.noConversation)}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending || templates.length === 0 || channels.length === 0}>
              {pending ? t.broadcast.sending : t.broadcast.send}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.broadcast.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
