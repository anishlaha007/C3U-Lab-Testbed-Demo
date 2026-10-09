/** Dense linear algebra helpers (small systems only). */

/** LU decomposition with partial pivoting of an n x n row-major matrix (in place). */
export function luDecompose(A: Float64Array, n: number): Int32Array {
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;
  for (let k = 0; k < n; k++) {
    let p = k;
    let max = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max < 1e-300) throw new Error('singular matrix');
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = A[k * n + j];
        A[k * n + j] = A[p * n + j];
        A[p * n + j] = t;
      }
      const t = piv[k];
      piv[k] = piv[p];
      piv[p] = t;
    }
    const akk = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = (A[i * n + k] /= akk);
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
    }
  }
  return piv;
}

export function luSolve(LU: Float64Array, piv: Int32Array, n: number, b: Float64Array): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = b[piv[i]];
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let j = 0; j < i; j++) s -= LU[i * n + j] * x[j];
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= LU[i * n + j] * x[j];
    x[i] = s / LU[i * n + i];
  }
  return x;
}
