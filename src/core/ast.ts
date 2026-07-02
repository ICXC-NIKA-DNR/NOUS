// AST node definitions. The AST is the single source of truth: one parser
// feeds both the plotting engine and the CAS layer (see CLAUDE.md).

export interface Span {
  start: number;
  end: number; // exclusive
}

export type RelOp = '<' | '<=' | '>' | '>=' | '=';

export type Expr =
  | NumLit
  | Ident
  | Unary
  | Binary
  | Postfix
  | Call
  | Relation
  | Restriction
  | Piecewise
  | Point
  | ListLit;

export interface NumLit {
  kind: 'num';
  value: number;
  span: Span;
}

export interface Ident {
  kind: 'ident';
  name: string;
  span: Span;
}

export interface Unary {
  kind: 'unary';
  op: '-' | '+';
  operand: Expr;
  span: Span;
}

export interface Binary {
  kind: 'binary';
  op: '+' | '-' | '*' | '/' | '^';
  left: Expr;
  right: Expr;
  /** true when the '*' was implicit (e.g. `2x`). Only meaningful for op '*'. */
  implicit?: boolean;
  span: Span;
}

export interface Postfix {
  kind: 'postfix';
  op: '!';
  operand: Expr;
  span: Span;
}

export interface Call {
  kind: 'call';
  callee: string;
  args: Expr[];
  /** false for paren-less application like `sin 2x`. */
  parens: boolean;
  span: Span;
}

/**
 * A (possibly chained) relation: `x = 1`, `0 < x < 5`, `y >= x^2`.
 * A single '=' at the top level is an equation; inequalities describe
 * conditions or implicit regions. The semantic layer decides which.
 */
export interface Relation {
  kind: 'relation';
  operands: Expr[]; // length n
  ops: RelOp[]; // length n - 1
  span: Span;
}

/** `expr { cond, cond }` — Desmos-style domain restriction. */
export interface Restriction {
  kind: 'restriction';
  body: Expr;
  conditions: Relation[];
  span: Span;
}

/**
 * `{cond: value, cond: value, fallback}` — Desmos-style piecewise, in primary
 * position (a trailing `{...}` after an expression is a Restriction instead).
 * Branches evaluate in order; no fallback and no true condition → NaN (gap).
 * `{cond}` with no value means "1 where cond holds" (Desmos shorthand).
 */
export interface Piecewise {
  kind: 'piecewise';
  branches: Array<{ condition: Relation; value: Expr }>;
  fallback?: Expr;
  span: Span;
}

/** `(a, b)` */
export interface Point {
  kind: 'point';
  x: Expr;
  y: Expr;
  span: Span;
}

/** `[1, 2, 3]` */
export interface ListLit {
  kind: 'list';
  items: Expr[];
  span: Span;
}

/* ------------------------------------------------------------------ */
/* Compact s-expression serializer — used by tests and for debugging. */
/* ------------------------------------------------------------------ */

export function sexpr(node: Expr): string {
  switch (node.kind) {
    case 'num': {
      const v = node.value;
      return Number.isInteger(v) ? String(v) : String(v);
    }
    case 'ident':
      return node.name;
    case 'unary':
      return `(${node.op === '-' ? 'neg' : 'pos'} ${sexpr(node.operand)})`;
    case 'binary':
      return `(${node.op} ${sexpr(node.left)} ${sexpr(node.right)})`;
    case 'postfix':
      return `(! ${sexpr(node.operand)})`;
    case 'call':
      return `(${node.callee} ${node.args.map(sexpr).join(' ')})`;
    case 'relation': {
      const parts: string[] = [sexpr(node.operands[0])];
      for (let i = 0; i < node.ops.length; i++) {
        parts.push(node.ops[i], sexpr(node.operands[i + 1]));
      }
      return `(rel ${parts.join(' ')})`;
    }
    case 'restriction':
      return `(where ${sexpr(node.body)} ${node.conditions.map(sexpr).join(' ')})`;
    case 'piecewise': {
      const parts = node.branches.map((b) => `(${sexpr(b.condition)} ${sexpr(b.value)})`);
      if (node.fallback) parts.push(sexpr(node.fallback));
      return `(cases ${parts.join(' ')})`;
    }
    case 'point':
      return `(pt ${sexpr(node.x)} ${sexpr(node.y)})`;
    case 'list':
      return `(list ${node.items.map(sexpr).join(' ')})`;
  }
}
