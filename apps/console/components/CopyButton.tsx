'use client';

import { useState } from 'react';

/** Copy-to-clipboard with the one bit of feedback that matters: whether it
 *  actually landed. A silent button leaves the agent pasting an empty
 *  clipboard into a brand's post. */
export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`btn sm ${copied ? 'primary' : ''}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard is blocked outside a secure context or without
          // permission; selecting the text by hand still works, so this
          // stays quiet rather than throwing a dialog at the agent.
        }
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
