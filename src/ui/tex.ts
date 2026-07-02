// AST → TeX for KaTeX display. Pure — no DOM, no KaTeX import — so it can be
// unit-tested under node:test like the core.
//
// Conventions (CLAUDE.md typography constraint): single-letter variables are
// italic (TeX default), multi-letter names upright via \mathrm, function
// names upright via TeX macros or \operatorname.

import type { Expr, RelOp } from '../core/ast.ts';

// Functions with a dedicated upright TeX macro.
const TEX_FUNCS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh',
  'exp', 'ln', 'log', 'min', 'max', 'gcd',
]);

const GREEK: Record<string, string> = {
  pi: '\\pi',
  tau: '\\tau',
  theta: '\\theta',
  phi: '\\phi',
};

const REL_TEX: Record<RelOp, string> = {
  '<': '<',
  '<=': '\\le',
  '>': '>',
  '>=': '\\ge',
  '=': '=',
};

// Precedence levels for parenthesization decisions.
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

function precOf(node: Expr): Prec {
  switch (node.kind) {
    case 'relation':
      return Prec.Rel;
    case 'restriction':
      return Prec.Rel;
    case 'binary':
      switch (node.op) {
        case '+':
        case '-':
          return Prec.Add;
        case '*':
          return Prec.Mul;
        case '/':
          return Prec.Atom; // rendered as \frac — self-delimiting
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

function child(node: Expr, min: Prec): string {
  const inner = toTex(node);
  return precOf(node) < min ? `\\left(${inner}\\right)` : inner;
}

function numTex(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '\\infty' : value < 0 ? '-\\infty' : '\\mathrm{NaN}';
  const s = String(value);
  const [mant, exp] = s.split('e');
  return exp === undefined ? mant : `${mant} \\times 10^{${Number(exp)}}`;
}

function identTex(name: string): string {
  if (name in GREEK) return GREEK[name];
  return name.length === 1 ? name : `\\mathrm{${name}}`;
}

/** true when `a · b` can be written by juxtaposition (2x, x sin x, 2(x+1)). */
function juxtaposable(right: Expr): boolean {
  switch (right.kind) {
    case 'num':
      return false; // 2·3 must keep its dot
    case 'ident':
    case 'call':
    case 'point':
      return true;
    case 'binary':
      return right.op === '/' ? true : false; // \frac is visually distinct
    case 'unary':
      return false; // 2·(-x) needs the dot (or parens); keep the dot
    default:
      return false;
  }
}

export function toTex(node: Expr): string {
  switch (node.kind) {
    case 'num':
      return numTex(node.value);

    case 'ident':
      return identTex(node.name);

    case 'unary':
      return `${node.op}${child(node.operand, Prec.Unary)}`;

    case 'binary': {
      switch (node.op) {
        case '+':
          return `${child(node.left, Prec.Add)} + ${child(node.right, Prec.Mul)}`;
        case '-':
          return `${child(node.left, Prec.Add)} - ${child(node.right, Prec.Mul)}`;
        case '*': {
          const l = child(node.left, Prec.Mul);
          // Right operand of · binds visually; unary needs wrapping either way.
          const r = child(node.right, Prec.Mul);
          return node.implicit && juxtaposable(node.right) ? `${l} ${r}` : `${l} \\cdot ${r}`;
        }
        case '/':
          return `\\frac{${toTex(node.left)}}{${toTex(node.right)}}`;
        case '^': {
          const base = child(node.left, Prec.Postfix); // (-x)^2, (x+1)^2 need parens
          return `${base}^{${toTex(node.right)}}`;
        }
      }
      break;
    }

    case 'postfix':
      return `${child(node.operand, Prec.Postfix)}!`;

    case 'call': {
      if (node.callee === 'sqrt' && node.args.length === 1) {
        return `\\sqrt{${toTex(node.args[0])}}`;
      }
      if (node.callee === 'cbrt' && node.args.length === 1) {
        return `\\sqrt[3]{${toTex(node.args[0])}}`;
      }
      if (node.callee === 'abs' && node.args.length === 1) {
        return `\\left|${toTex(node.args[0])}\\right|`;
      }
      const name = TEX_FUNCS.has(node.callee)
        ? `\\${node.callee}`
        : `\\operatorname{${node.callee}}`;
      const args = node.args.map(toTex).join(', ');
      return node.parens || node.args.length > 1
        ? `${name}\\left(${args}\\right)`
        : `${name} ${child(node.args[0], Prec.Mul)}`;
    }

    case 'relation': {
      const parts: string[] = [toTex(node.operands[0])];
      for (let i = 0; i < node.ops.length; i++) {
        parts.push(REL_TEX[node.ops[i]], toTex(node.operands[i + 1]));
      }
      return parts.join(' ');
    }

    case 'restriction': {
      const conds = node.conditions.map(toTex).join(',\\; ');
      return `${toTex(node.body)} \\;\\left\\{${conds}\\right\\}`;
    }

    case 'piecewise': {
      const rows = node.branches.map((b) => `${toTex(b.value)} & ${toTex(b.condition)}`);
      if (node.fallback) rows.push(`${toTex(node.fallback)} & \\text{otherwise}`);
      return `\\begin{cases}${rows.join(' \\\\ ')}\\end{cases}`;
    }

    case 'point':
      return `\\left(${toTex(node.x)}, ${toTex(node.y)}\\right)`;

    case 'list':
      return `\\left[${node.items.map(toTex).join(', ')}\\right]`;
  }
}
