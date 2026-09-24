'use client';

import NextLink, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';

// The App Router's Link implements this prop; the public `next/link` types
// (shared with the Pages Router) don't list it yet.
const dynamicOnHover = { unstable_dynamicOnHover: true } as Record<string, unknown>;

/**
 * `next/link` that fetches the whole page the moment the pointer rests on it.
 *
 * Every page here is `force-dynamic`, and Next's default prefetch stops short
 * of dynamic content — so a click used to wait for a full server render
 * before anything moved. Hover comes a few hundred milliseconds before the
 * click, which is usually longer than the render takes; by the time the
 * button goes down the page is already in memory and opens at once.
 *
 * Only on hover, not on scroll-into-view: fetching all thirty rail links on
 * every page load would cost a slow machine more than it saves.
 *
 * When a click does beat the fetch (a tap, a keyboard press), the link itself
 * answers at once — `.link-pending`, styled in globals.css, lights the rail
 * item up as selected — instead of the screen sitting still.
 */
export default function Link({ children, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink {...dynamicOnHover} {...props}>
      {children}
      <PendingMark />
    </NextLink>
  );
}

function PendingMark() {
  const { pending } = useLinkStatus();
  return pending ? <span className="link-pending" hidden /> : null;
}
