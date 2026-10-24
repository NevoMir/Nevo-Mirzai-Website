import { useSyncExternalStore } from 'react';

/**
 * Read-only "is the dark theme on" for components that must react to it
 * without owning it. `useTheme` APPLIES the theme (it adds/removes the class
 * in an effect), so calling it from many components — every wire on the
 * canvas, say — would install that many theme controllers.
 *
 * One MutationObserver serves every subscriber.
 */
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      for (const listener of listeners) listener();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

const getSnapshot = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
