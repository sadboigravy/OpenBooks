import { useEffect, useState } from 'react';
// Light / dark / system theme, remembered per browser.
const KEY = 'openbooks.theme';
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref = getThemePreference()) {
  if (pref === 'system') return media && media.matches ? 'dark' : 'light';
  return pref;
}

export function applyTheme(pref = getThemePreference()) {
  document.documentElement.dataset.theme = resolvedTheme(pref);
}

export function setThemePreference(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: still apply for this page view */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event('openbooks:theme'));
}

/** Re-apply when the OS theme changes while following the system. */
export function watchSystemTheme() {
  if (!media) return;
  const onChange = () => {
    if (getThemePreference() === 'system') {
      applyTheme('system');
      window.dispatchEvent(new Event('openbooks:theme'));
    }
  };
  if (media.addEventListener) media.addEventListener('change', onChange);
  else if (media.addListener) media.addListener(onChange);
}

/** Read a CSS custom property (used to theme charts). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The interface zoom used on very wide screens (1 normally); updates when the window is resized. */
export function useUiZoom() {
  const read = () => parseFloat(cssVar('--ui-zoom')) || 1;
  const [zoom, setZoom] = useState(read);
  useEffect(() => {
    const onResize = () => setZoom(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return zoom;
}
