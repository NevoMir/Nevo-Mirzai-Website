import { useEffect, useState } from 'react';

/**
 * A sideways-scrolling strip with no scrollbar line (docs/CAD_EDITOR_PLAN.md, Step ED10 decision 10): its clipped
 * end fades over FADE_PX instead (`data-fade` start, end or both, and a CSS mask), and a vertical wheel over it
 * scrolls it sideways while it overflows (a mouse has no bar left to drag). Trackpads and Shift+wheel scroll it as
 * before. What is scrolled into view or reached by the keyboard (the active tab, a focused control) keeps FADE_PX clear
 * of each end, out of the fade (scroll padding, and on focus). The strip carries HIDDEN_BAR and the callback ref this
 * returns (a strip mounted later is followed).
 */
export const HIDDEN_BAR = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
export const FADE_PX = 24;

const MASKS: Record<string, string> = {
  start: `linear-gradient(to right, transparent, #000 ${FADE_PX}px)`,
  end: `linear-gradient(to right, #000 calc(100% - ${FADE_PX}px), transparent)`,
  both: `linear-gradient(to right, transparent, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), transparent)`,
};

export function useEdgeFade<T extends HTMLElement = HTMLDivElement>(): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    el.style.scrollPaddingInline = `${FADE_PX}px`;
    const sync = () => {
      const over = el.scrollWidth - el.clientWidth;
      const start = over > 1 && el.scrollLeft > 1;
      const end = over > 1 && el.scrollLeft < over - 1;
      const fade = start && end ? 'both' : start ? 'start' : end ? 'end' : null;
      if (fade) el.dataset.fade = fade;
      else delete el.dataset.fade;
      el.style.maskImage = el.style.webkitMaskImage = fade ? MASKS[fade] : '';
    };
    const wheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.ctrlKey) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
      sync();
    };
    // Chrome's focus scrolls only a control out of the box, not one half shown or under the fade (measured): one the
    // keyboard reaches is scrolled clear. The mouse's is left alone, so its control does not move under the press.
    const focused = (event: FocusEvent) => {
      const target = event.target as Element;
      if (target.matches(':focus-visible')) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('focusin', focused);
    // Its size, and what it holds (a tab or a button coming or going).
    const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    resized?.observe(el);
    const changed = new MutationObserver(sync);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', sync);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('focusin', focused);
      resized?.disconnect();
      changed.disconnect();
      el.style.scrollPaddingInline = '';
    };
  }, [el]);
  return setEl;
}
