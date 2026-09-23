'use client';

import { useEffect, useRef } from 'react';

/**
 * Opens a conversation at its newest message instead of its oldest.
 *
 * Rendered as the last child of `.thread-body`, which is the scroll container.
 * A thread with months of history otherwise opens on a greeting from weeks ago
 * and the agent has to scroll to find what they were actually called here to
 * answer.
 *
 * `conversationId` is the remount key: these pages are server components that
 * re-render when navigating between threads, and without it the effect would
 * not re-run for the thread the agent just clicked.
 */
export function ScrollToLatest({
  conversationId, messageCount,
}: { conversationId: string; messageCount: number }) {
  const anchor = useRef<HTMLDivElement>(null);
  // Whether the agent was reading the newest messages when an update arrived.
  // Kept in a ref rather than state: it is read inside the next effect, and
  // re-rendering on every scroll event would be a needless cost on a list that
  // can hold hundreds of bubbles.
  const wasAtBottom = useRef(true);

  const scrollerOf = (el: HTMLElement | null) => el?.closest('.thread-body') as HTMLElement | null;

  // Opening the thread: jump, never glide. A smooth scroll through a long
  // history is a visible slide the agent has to wait out every single time.
  useEffect(() => {
    const scroller = scrollerOf(anchor.current);
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    wasAtBottom.current = true;
  }, [conversationId]);

  // These pages refresh on a timer, so new messages arrive while the agent is
  // reading. Following them down is right only when they were already at the
  // bottom — doing it unconditionally would yank the view away from someone
  // scrolled up reading history, every ten seconds.
  useEffect(() => {
    const scroller = scrollerOf(anchor.current);
    if (!scroller || !wasAtBottom.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messageCount]);

  useEffect(() => {
    const scroller = scrollerOf(anchor.current);
    if (!scroller) return;

    const onScroll = () => {
      // A small tolerance, because fractional scroll heights mean an element
      // scrolled fully to the bottom often reports a pixel or two short of it.
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      wasAtBottom.current = distance < 80;
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  return <div ref={anchor} aria-hidden style={{ scrollMarginBlockEnd: 0 }} />;
}
