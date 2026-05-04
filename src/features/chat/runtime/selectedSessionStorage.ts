const SELECTED_SESSION_STORAGE_KEY = 'nerve:chat:selected-session';

export interface SelectedSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

function defaultStorage(): SelectedSessionStorage | null {
  return typeof window !== 'undefined' ? window.localStorage : null;
}

export function persistSelectedSession(
  sessionKey: string,
  storage: SelectedSessionStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  if (sessionKey.trim()) {
    storage.setItem(SELECTED_SESSION_STORAGE_KEY, sessionKey);
  } else {
    storage.removeItem(SELECTED_SESSION_STORAGE_KEY);
  }
}

export function restoreSelectedSession(
  storage: SelectedSessionStorage | null = defaultStorage(),
): string | null {
  if (!storage) return null;
  const value = storage.getItem(SELECTED_SESSION_STORAGE_KEY);
  return value?.trim() || null;
}
