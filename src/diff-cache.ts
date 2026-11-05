export type DiffRequest = { path: string; hash?: string; staged?: boolean; untracked?: boolean };
type Entry = { key: string; root: string; bytes: number; value?: string; request: Promise<string> };
type Job = { entry: Entry; priority: number; start: () => void; cancel: () => void };

/** Two shared workers, foreground priority, and a 64 MiB text cache. */
export class DiffCache {
  private entries = new Map<string, Entry>();
  private pins = new Map<string, number>();
  private queue: Job[] = [];
  private running = 0;
  private bytes = 0;
  private activeRoot: string | null = null;
  constructor(private fetch: (root: string, request: DiffRequest) => Promise<string>, private budget = 64 * 1024 * 1024) {}
  private key(root: string, request: DiffRequest, version: string) {
    return JSON.stringify([root, request.path, request.hash, Boolean(request.staged), Boolean(request.untracked), version]);
  }
  private touch(entry: Entry) { this.entries.delete(entry.key); this.entries.set(entry.key, entry); }
  private trim() {
    for (const inactiveOnly of [true, false]) {
      for (const [key, entry] of this.entries) {
        if (this.bytes <= this.budget) return;
        if (entry.value === undefined || this.pins.has(key) || (inactiveOnly && entry.root === this.activeRoot)) continue;
        this.bytes -= entry.bytes; this.entries.delete(key);
      }
    }
  }
  activate(root: string | null) { this.activeRoot = root; this.trim(); }
  peek(root: string, request: DiffRequest, version: string): string | undefined {
    const entry = this.entries.get(this.key(root, request, version));
    if (entry) this.touch(entry);
    return entry?.value;
  }
  pin(root: string, request: DiffRequest, version: string): () => void {
    const key = this.key(root, request, version);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; const count = this.pins.get(key) ?? 0; if (count <= 1) this.pins.delete(key); else this.pins.set(key, count - 1); this.trim(); };
  }
  load(root: string, request: DiffRequest, version: string, priority = 0): Promise<string> {
    const key = this.key(root, request, version), existing = this.entries.get(key);
    if (existing) {
      this.touch(existing);
      const job = this.queue.find(job => job.entry === existing);
      if (job) job.priority = Math.min(job.priority, priority);
      return existing.request;
    }
    let resolve!: (value: string) => void, reject!: (error: unknown) => void;
    const entry: Entry = { key, root, bytes: 0, request: new Promise((done, failed) => { resolve = done; reject = failed; }) };
    this.entries.set(key, entry);
    this.queue.push({ entry, priority, cancel: () => { this.entries.delete(key); reject(new DOMException('Prefetch cancelled', 'AbortError')); }, start: () => {
      this.running++;
      Promise.resolve().then(() => this.fetch(root, request)).then(value => {
        entry.value = value; entry.bytes = value.length * 2; this.bytes += entry.bytes;
        this.touch(entry); this.trim(); resolve(value);
      }, error => { this.entries.delete(key); reject(error); }).finally(() => { this.running--; this.pump(); });
    } });
    queueMicrotask(() => this.pump());
    return entry.request;
  }
  private pump() {
    if (this.running >= 2 || !this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.running < 2 && this.queue.length) this.queue.shift()!.start();
  }
  cancelPrefetch(root: string, request?: DiffRequest, version = '') {
    const key = request ? this.key(root, request, version) : undefined;
    this.queue = this.queue.filter(job => {
      if (job.entry.root !== root || job.priority === 0 || (key !== undefined && job.entry.key !== key)) return true;
      job.cancel(); return false;
    });
  }
}

export const diffCache = new DiffCache((root, request) => window.gitforge.fileDiff(root, request));
export const cachedDiff = (root: string, request: DiffRequest, version: string) => diffCache.load(root, request, version);
