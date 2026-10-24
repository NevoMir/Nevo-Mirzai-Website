import { useState, useEffect } from 'react';

/**
 * Theme policy: AUTOMATIC unless the user has explicitly chosen.
 * - Auto follows the operating system's light/dark setting, live.
 * - Where that signal is unavailable, fall back to the clock: light
 *   between sunrise-ish (07:00) and sunset-ish (19:00), dark otherwise.
 * - The toggle stores an explicit choice that wins from then on.
 */

/**
 * What the user picked, as the settings dialog shows it: 'system' means no
 * explicit choice is stored, so the auto rules above keep applying.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Pure resolver, exported for tests. */
export function resolveAutoTheme(prefersDark: boolean | null, hour: number): 'dark' | 'light' {
  if (prefersDark !== null) return prefersDark ? 'dark' : 'light';
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

function osPrefersDark(): boolean | null {
  if (typeof window.matchMedia !== 'function') return null;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  // Engines without support report media "not all".
  if (mq.media === 'not all') return null;
  return mq.matches;
}

function getAutoTheme(): 'dark' | 'light' {
  return resolveAutoTheme(osPrefersDark(), new Date().getHours());
}

/** Explicit user choices only: auto-derived values are never stored. */
/** Must match the pre-paint script in assignment_alex/index.html. */
const CHOICE_KEY = 'assembly-studio-theme';

function savedChoice(): 'dark' | 'light' | null {
  try {
    const saved = localStorage.getItem(CHOICE_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

const THEME_EVENT = 'assembly-studio-theme-change';

/**
 * What one useTheme instance tells the others.
 *
 * It carries the MODE as well as the resolved theme, which it did not used to.
 * The listener re-read the stored choice instead — and setTheme's own dispatch
 * runs that listener SYNCHRONOUSLY on the instance that dispatched, so where
 * localStorage is unavailable (Safari private browsing, site data blocked) the
 * setItem threw, savedChoice() answered null, and picking Light or Dark in
 * Settings was overwritten back to 'system' two lines after it was set: the
 * segmented control kept highlighting "System" and the OS media listener stayed
 * armed, so the next OS flip undid the choice. Exactly the opposite of what the
 * catch block promises ("the choice still applies for this session").
 *
 * A bare string detail is still accepted, so an event from an older bundle in
 * another tab does not blank the mode.
 */
interface ThemeChangeDetail {
  theme: 'dark' | 'light';
  mode: ThemeMode;
}

function announce(theme: 'dark' | 'light', mode: ThemeMode): void {
  window.dispatchEvent(new CustomEvent<ThemeChangeDetail>(THEME_EVENT, { detail: { theme, mode } }));
}

export function useTheme() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(() => savedChoice() ?? getAutoTheme());
  // The stored CHOICE, which is what the settings dialog highlights. It is
  // not derivable from `theme`: an explicit 'dark' and an auto-resolved
  // 'dark' render identically but behave differently when the OS flips.
  const [mode, setModeState] = useState<ThemeMode>(() => savedChoice() ?? 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // AUTO mode: follow the OS setting live (and never persist auto values —
  // persisting is what turns a theme into an explicit choice).
  //
  // Keyed on `mode`, not mounted once: someone who loaded the page with Light
  // stored and then picks "System" in Settings has to START following the OS
  // within the session, which an empty dependency array cannot do (the
  // listener was never registered, so nothing happened until a reload).
  useEffect(() => {
    if (mode !== 'system') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.media === 'not all' || typeof mq.addEventListener !== 'function') return;
    const onChange = () => {
      // A stored choice while THIS instance is on 'system' can only have come
      // from another tab; leave it alone rather than following the OS over it.
      // Where storage is unreadable this never fires, which is the point: the
      // mode, not storage, is what decides whether to follow the OS.
      if (savedChoice() !== null) return;
      const next = getAutoTheme();
      setThemeState(next);
      announce(next, 'system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  // Keep every useTheme instance in sync (header toggle, settings switch, ...).
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ThemeChangeDetail | 'dark' | 'light'>).detail;
      if (detail === 'dark' || detail === 'light') {
        // Legacy shape (another tab on an older bundle): the theme only, so
        // storage is the best available answer for the mode.
        setThemeState(detail);
        setModeState(savedChoice() ?? 'system');
        return;
      }
      if (!detail) return;
      if (detail.theme === 'dark' || detail.theme === 'light') setThemeState(detail.theme);
      setModeState(detail.mode);
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  const setTheme = (next: 'dark' | 'light') => {
    try {
      localStorage.setItem(CHOICE_KEY, next);
    } catch {
      // Storage unavailable — the choice still applies for this session, which
      // is only true because the event below carries the mode rather than
      // asking storage for it back.
    }
    setModeState(next);
    setThemeState(next);
    announce(next, next);
  };

  /** The settings dialog's three-way control. 'system' DROPS the choice. */
  const setMode = (next: ThemeMode) => {
    if (next !== 'system') {
      setTheme(next);
      return;
    }
    try {
      localStorage.removeItem(CHOICE_KEY);
    } catch {
      // Storage unavailable — auto still applies for this session.
    }
    const auto = getAutoTheme();
    setModeState('system');
    setThemeState(auto);
    announce(auto, 'system');
  };

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  return { theme, mode, setTheme, setMode, toggleTheme, isDark: theme === 'dark' };
}
