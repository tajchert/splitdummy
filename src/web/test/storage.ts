/**
 * Node 25+ exposes an experimental global `localStorage` that is undefined without
 * --localstorage-file and shadows jsdom's. Tests get a simple in-memory Storage instead.
 */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

let ok = false;
try {
  ok = typeof globalThis.localStorage?.getItem === "function";
} catch {
  ok = false;
}
if (!ok) Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
