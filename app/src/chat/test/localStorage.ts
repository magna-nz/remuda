/**
 * localStorage shim for tests.
 *
 * Node ≥22 defines an experimental `globalThis.localStorage` getter that
 * yields undefined unless the process was started with --localstorage-file.
 * Because the key already exists on globalThis, vitest's jsdom environment
 * skips copying jsdom's real Storage over it — leaving tests without one.
 * Import this module (for its side effect) before anything touches
 * window.localStorage.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
