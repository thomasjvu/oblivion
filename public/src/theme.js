export const THEMES = ["onebit", "gb"];
export const DEFAULT_THEME = "onebit";
export const STORAGE_KEY = "oblivion.theme";

export function isValidTheme(id) {
  return THEMES.includes(id);
}

export function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id) {
  const themeId = isValidTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = themeId;
  document.documentElement.style.colorScheme = "dark";
  return themeId;
}

export function setTheme(id) {
  const themeId = applyTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    /* ignore quota / private mode */
  }
  return themeId;
}