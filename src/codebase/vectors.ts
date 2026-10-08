/** Vector helpers for the local codebase index. Vectors are stored L2-normalized. */

export function normalize(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    sum += out[i] * out[i];
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) {
    out[i] /= norm;
  }
  return out;
}

/** Cosine similarity of two normalized vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  // Copy into an aligned buffer; Buffer slices may start at any byte offset.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** The k highest-scoring items, best first. */
export function topK<T>(items: Iterable<T>, score: (item: T) => number, k: number): { item: T; score: number }[] {
  const best: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = score(item);
    if (best.length < k || s > best[best.length - 1].score) {
      best.push({ item, score: s });
      best.sort((x, y) => y.score - x.score);
      if (best.length > k) {
        best.pop();
      }
    }
  }
  return best;
}
