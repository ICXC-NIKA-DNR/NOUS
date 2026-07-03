// Exact rational arithmetic on bigints (CAS_SPEC.md). Used by simplify and
// solve so constant folding stays exact: 1/3 + 1/6 = 1/2, never a float.
// Pure and self-contained — no AST knowledge except the toExpr convenience.

import type { Expr, Span } from '../core/ast.ts';

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export class Rational {
  /** Invariants: d > 0, gcd(|n|, d) = 1. */
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }

  static of(n: bigint | number, d: bigint | number = 1n): Rational {
    let nn = typeof n === 'number' ? BigInt(n) : n;
    let dd = typeof d === 'number' ? BigInt(d) : d;
    if (dd === 0n) throw new RangeError('Rational with zero denominator');
    if (dd < 0n) {
      nn = -nn;
      dd = -dd;
    }
    const g = gcd(nn, dd);
    return g === 0n ? new Rational(0n, 1n) : new Rational(nn / g, dd / g);
  }

  static readonly ZERO = Rational.of(0n);
  static readonly ONE = Rational.of(1n);

  /**
   * Exact conversion: every finite double is m·2^e with integer m, so the
   * result is exact by construction (possibly with a large denominator for
   * decimals like 0.1 — that's honesty, not a bug; simplify only folds
   * literals that stay presentable).
   */
  static fromNumber(x: number): Rational | null {
    if (!Number.isFinite(x)) return null;
    if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) {
      return Rational.of(BigInt(x));
    }
    // Decompose the double: x = m * 2^e exactly.
    let m = x;
    let e = 0;
    while (!Number.isInteger(m)) {
      m *= 2;
      e++;
      if (e > 1100) return null; // subnormal edge; give up rather than loop
    }
    if (Math.abs(m) > Number.MAX_SAFE_INTEGER) return null;
    return Rational.of(BigInt(m), 1n << BigInt(e));
  }

  add(o: Rational): Rational {
    return Rational.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o: Rational): Rational {
    return Rational.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o: Rational): Rational {
    return Rational.of(this.n * o.n, this.d * o.d);
  }

  div(o: Rational): Rational {
    if (o.n === 0n) throw new RangeError('Rational division by zero');
    return Rational.of(this.n * o.d, this.d * o.n);
  }

  neg(): Rational {
    return Rational.of(-this.n, this.d);
  }

  abs(): Rational {
    return this.n < 0n ? this.neg() : this;
  }

  /** Integer powers only (negative allowed for nonzero base). */
  pow(k: bigint): Rational {
    if (k === 0n) return Rational.ONE;
    if (k < 0n) {
      if (this.n === 0n) throw new RangeError('0 to a negative power');
      return Rational.of(this.d ** -k, this.n ** -k);
    }
    return Rational.of(this.n ** k, this.d ** k);
  }

  cmp(o: Rational): -1 | 0 | 1 {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  eq(o: Rational): boolean {
    return this.n === o.n && this.d === o.d;
  }

  get isZero(): boolean {
    return this.n === 0n;
  }

  get isOne(): boolean {
    return this.n === 1n && this.d === 1n;
  }

  get isInteger(): boolean {
    return this.d === 1n;
  }

  get sign(): -1 | 0 | 1 {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  }

  toNumber(): number {
    const q = Number(this.n / this.d);
    const r = Number(this.n % this.d) / Number(this.d);
    return q + r;
  }

  /**
   * Render as an AST literal: a plain num when the value round-trips through
   * a double exactly, else num/num so nothing is silently lost.
   */
  toExpr(span: Span = { start: 0, end: 0 }): Expr {
    const asNumber = this.toNumber();
    const back = Rational.fromNumber(asNumber);
    if (back !== null && back.eq(this)) {
      return asNumber < 0
        ? {
            kind: 'unary',
            op: '-',
            operand: { kind: 'num', value: -asNumber, span },
            span,
          }
        : { kind: 'num', value: asNumber, span };
    }
    const numAbs: Expr = { kind: 'num', value: Number(this.n < 0n ? -this.n : this.n), span };
    const den: Expr = { kind: 'num', value: Number(this.d), span };
    const frac: Expr = { kind: 'binary', op: '/', left: numAbs, right: den, span };
    return this.n < 0n ? { kind: 'unary', op: '-', operand: frac, span } : frac;
  }

  toString(): string {
    return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`;
  }
}
