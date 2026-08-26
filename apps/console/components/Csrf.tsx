'use client';

import { createContext, useContext } from 'react';

const CsrfContext = createContext('');

export function CsrfProvider({ token, children }: { token: string; children: React.ReactNode }) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

/**
 * Drop this inside every form. It works in server and client components alike,
 * so there is one thing to remember rather than two.
 */
export function CsrfField() {
  const token = useContext(CsrfContext);
  return <input type="hidden" name="csrf" value={token} />;
}
