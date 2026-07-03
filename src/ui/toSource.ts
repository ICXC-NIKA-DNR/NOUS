// AST → gcalc input syntax. The inverse of the parser, precedence-aware, so
// CAS results can be inserted as editable sidebar rows. Round-trip contract
// (tested): parse(toSource(e)) is structurally equal to e.

import type { Expr, RelOp } from '../core/ast.ts';

const Prec = {
  Rel: 0,
  Add: 1,
  Mul: 2,
  Unary: 3,
  Pow: 4,
  Postfix: 5,
  Atom: 6,
} as const;
type Prec = (typeof Prec)[keyof typeof Prec];

function precOf(e: Expr): Prec {
  switch (e.kind) {
    case 'relation':
    case 'restriction':
      return Prec.Rel;
    case 'binary':
      switch (e.op) {
        case '+':
        case '-':
          return Prec.Add;
        case '*':
        case '/':
          return Prec.Mul;
        case '^':
          return Prec.Pow;
      }
      break;
    case 'unary':
      return Prec.Unary;
    case 'postfix':
      return Prec.Postfix;
    default:
      return Prec.Atom;
  }
}

function wrap(e: Expr, min: Prec): string {
  const s = toSource(e);
  return precOf(e) < min ? `(${s})` : s;
}

function numSource(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

export function toSource(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return numSource(e.value);
    case 'ident':
      return e.name;
    case 'unary':
      return `${e.op}${wrap(e.operand, Prec.Unary)}`;
    case 'binary': {
      switch (e.op) {
        case '+':
          return `${wrap(e.left, Prec.Add)} + ${wrap(e.right, Prec.Mul)}`;
        case '-':
          return `${wrap(e.left, Prec.Add)} - ${wrap(e.right, Prec.Mul)}`;
        case '*':
          return `${wrap(e.left, Prec.Mul)} * ${wrap(e.right, Prec.Unary)}`;
        case '/':
          return `${wrap(e.left, Prec.Mul)} / ${wrap(e.right, Prec.Unary)}`;
        case '^': {
          // Right side binds tighter than unary so -x^2 round-trips; the
          // parser accepts x^-2 directly.
          const exp = e.right.kind === 'unary' ? toSource(e.right) : wrap(e.right, Prec.Pow);
          return `${wrap(e.left, Prec.Postfix)}^${exp}`;
        }
      }
      break;
    }
    case 'postfix':
      return `${wrap(e.operand, Prec.Postfix)}!`;
    case 'call':
      return `${e.callee}(${e.args.map(toSource).join(', ')})`;
    case 'relation': {
      const parts: string[] = [toSource(e.operands[0])];
      e.ops.forEach((op: RelOp, i: number) => {
        parts.push(op, toSource(e.operands[i + 1]));
      });
      return parts.join(' ');
    }
    case 'restriction':
      return `${toSource(e.body)} {${e.conditions.map(toSource).join(', ')}}`;
    case 'piecewise': {
      const parts = e.branches.map((b) => `${toSource(b.condition)}: ${toSource(b.value)}`);
      if (e.fallback) parts.push(toSource(e.fallback));
      return `{${parts.join(', ')}}`;
    }
    case 'point':
      return `(${toSource(e.x)}, ${toSource(e.y)})`;
    case 'list':
      return `[${e.items.map(toSource).join(', ')}]`;
  }
}
