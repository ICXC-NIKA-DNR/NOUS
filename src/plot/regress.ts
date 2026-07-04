// Least-squares regressions on data tables (M6): linear, polynomial,
// exponential. Pure numeric module — the UI formats coefficients into an
// expression row at display precision.
//
// The exponential fit linearizes ln y = ln a + b·x (classic least squares on
// the log), which requires strictly positive y values; it returns null
// otherwise rather than fabricating a fit.

export interface Pt {
  x: number;
  y: number;
}

export interface LinearFit {
  m: number;
  b: number;
  r2: number;
}

export interface PolyFit {
  /** Coefficients low→high degree: y = c0 + c1·x + … + cn·xⁿ. */
  coeffs: number[];
  r2: number;
}

export interface ExpFit {
  a: number;
  b: number; // y = a·e^(b·x)
  r2: number;
}

function rSquared(pts: Pt[], predict: (x: number) => number): number {
  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    ssRes += (p.y - predict(p.x)) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  return ssTot === 0 ? 1 : 1 - ssRes / ssTot;
}

export function linearFit(pts: Pt[]): LinearFit | null {
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null; // vertical data
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  return { m, b, r2: rSquared(pts, (x) => m * x + b) };
}

/** Solve A·x = v by Gaussian elimination with partial pivoting. */
function solveLinearSystem(A: number[][], v: number[]): number[] | null {
  const n = v.length;
  const M = A.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

export function polyFit(pts: Pt[], degree: number): PolyFit | null {
  if (degree < 1 || pts.length < degree + 1) return null;
  const n = degree + 1;
  // Normal equations: (Vᵀ·V)·c = Vᵀ·y over the Vandermonde matrix V.
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const v = new Array<number>(n).fill(0);
  for (const p of pts) {
    const powers: number[] = [1];
    for (let k = 1; k < 2 * n - 1; k++) powers.push(powers[k - 1] * p.x);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += powers[i + j];
      v[i] += powers[i] * p.y;
    }
  }
  const coeffs = solveLinearSystem(A, v);
  if (coeffs === null) return null;
  const predict = (x: number): number =>
    coeffs.reduce((acc, c, k) => acc + c * x ** k, 0);
  return { coeffs, r2: rSquared(pts, predict) };
}

export function expFit(pts: Pt[]): ExpFit | null {
  if (pts.length < 2 || pts.some((p) => p.y <= 0)) return null;
  const logged = pts.map((p) => ({ x: p.x, y: Math.log(p.y) }));
  const lin = linearFit(logged);
  if (lin === null) return null;
  const a = Math.exp(lin.b);
  const b = lin.m;
  return { a, b, r2: rSquared(pts, (x) => a * Math.exp(b * x)) };
}
