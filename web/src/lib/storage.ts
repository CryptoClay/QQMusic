/** Preserve browser state when upgrading HomeMusic on the same origin.
 * A failed write never destroys the old value. Acknowledgements remove both keys. */
export function compatibleStorage(resolve: () => Storage): Storage {
  const canonical = (key: string) => key.replace(/^hm-/, 'qqmusic-');
  const legacy = (key: string) => key.replace(/^qqmusic-/, 'hm-');
  const keys = () => {
    const storage = resolve();
    return [...new Set(Array.from({ length: storage.length }, (_, i) => canonical(storage.key(i) ?? '')))];
  };
  return {
    get length() {
      return keys().length;
    },
    key(index: number) {
      return keys()[index] ?? null;
    },
    getItem(key: string) {
      const storage = resolve();
      const current = storage.getItem(key);
      if (current !== null) return current;
      const oldKey = legacy(key);
      if (oldKey === key) return null;
      const value = storage.getItem(oldKey);
      if (value !== null) {
        try {
          storage.setItem(key, value);
        } catch {
          /* retain readable legacy state */
        }
      }
      return value;
    },
    setItem(key: string, value: string) {
      const storage = resolve();
      storage.setItem(key, value);
      if (legacy(key) !== key) storage.removeItem(legacy(key));
    },
    removeItem(key: string) {
      const storage = resolve();
      storage.removeItem(key);
      if (legacy(key) !== key) storage.removeItem(legacy(key));
    },
    clear() {
      resolve().clear();
    },
  };
}

export const clientStorage = compatibleStorage(() => window.localStorage);
export const tabStorage = compatibleStorage(() => window.sessionStorage);
