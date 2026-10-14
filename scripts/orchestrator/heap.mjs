// Indexed binary min-heap: push / pop / peek in O(log n), and update(key) re-sifts one entry
// in O(log n) when its priority changes. The frontier needs update(): a template's in-degree
// grows while its nodes wait in the queue, so their priority moves after they were pushed.

export class IndexedHeap {
  /** @param {(a: any, b: any) => number} compare negative when a comes first */
  constructor(compare) {
    this.compare = compare;
    this.items = [];
    this.pos = new Map();
  }

  get size() {
    return this.items.length;
  }

  has(key) {
    return this.pos.has(key);
  }

  push(key, value) {
    if (this.pos.has(key)) return this.update(key, value);
    this.items.push({ key, value });
    this.pos.set(key, this.items.length - 1);
    this.#up(this.items.length - 1);
  }

  peek() {
    return this.items[0]?.key;
  }

  pop() {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    this.#remove(0);
    return top.key;
  }

  delete(key) {
    const i = this.pos.get(key);
    if (i !== undefined) this.#remove(i);
  }

  /** Re-sift one entry; `value` replaces its payload when given. */
  update(key, value) {
    const i = this.pos.get(key);
    if (i === undefined) return;
    if (value !== undefined) this.items[i].value = value;
    this.#up(i);
    this.#down(this.pos.get(key));
  }

  keys() {
    return [...this.items].sort((a, b) => this.compare(a.value, b.value)).map((e) => e.key);
  }

  #remove(i) {
    const last = this.items.pop();
    this.pos.delete(this.items[i]?.key ?? last.key);
    if (i < this.items.length) {
      this.items[i] = last;
      this.pos.set(last.key, i);
      this.#up(i);
      this.#down(this.pos.get(last.key));
    }
  }

  #less(i, j) {
    return this.compare(this.items[i].value, this.items[j].value) < 0;
  }

  #swap(i, j) {
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    this.pos.set(this.items[i].key, i);
    this.pos.set(this.items[j].key, j);
  }

  #up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  #down(i) {
    const n = this.items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.#less(l, m)) m = l;
      if (r < n && this.#less(r, m)) m = r;
      if (m === i) break;
      this.#swap(i, m);
      i = m;
    }
  }
}
