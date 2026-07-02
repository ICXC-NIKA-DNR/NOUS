// Recursive-descent / Pratt parser. Input syntax spec of record lives in
// parser.test.ts. Precedence, loosest → tightest:
//
//   relation chains (< <= > >= =)         0 < x < 5
//   additive (+ -)
//   multiplicative (* / and implicit)     2x, (x+1)(x-1), 1/2x = (1/2)·x
//   unary (- +)                           -x^2 = -(x^2)
//   power (^, right-assoc)                x^y^z = x^(y^z), x^-2 works
//   postfix (!)
//   primary (numbers, idents, calls, groups, points, lists, |abs|)
//
// Paren-less function application (`sin 2x`) takes an implicit product as its
// argument: `sin 2x` = sin(2x); `sin x + 1` = sin(x) + 1.
// A trailing `{...}` attaches domain-restriction conditions to the whole line.

import type { Expr, Relation, RelOp, Span } from './ast.ts';
import { fail, nearestName } from './errors.ts';
import { lex, type LexOptions, type Token } from './lexer.ts';
import { FUNCTION_NAMES } from './names.ts';

export interface ParseOptions extends LexOptions {
  /** Names to treat as callable functions in addition to the builtins. */
  functionNames?: Iterable<string>;
}

export function parse(source: string, options: ParseOptions = {}): Expr {
  const functions = new Set<string>(FUNCTION_NAMES);
  if (options.functionNames) for (const n of options.functionNames) functions.add(n);
  const extraNames = new Set<string>(options.extraNames ?? []);
  for (const n of functions) if (n.length > 1) extraNames.add(n);

  const tokens = lex(source, { extraNames });
  let pos = 0;
  let absDepth = 0;

  const peek = (): Token => tokens[pos];
  const next = (): Token => tokens[pos++];
  const at = (type: Token['type'], text?: string): boolean =>
    peek().type === type && (text === undefined || peek().text === text);

  const spanFrom = (start: Span, end: Span): Span => ({ start: start.start, end: end.end });

  if (peek().type === 'eof') {
    fail({ kind: 'empty-input', message: 'Enter an expression.', span: { start: 0, end: 0 } });
  }

  const expr = parseRelation();

  // trailing restriction: expr { cond, cond }
  let result: Expr = expr;
  if (at('lbrace')) {
    const open = next();
    const conditions: Relation[] = [];
    for (;;) {
      const cond = parseRelation();
      if (cond.kind !== 'relation') {
        fail({
          kind: 'not-a-condition',
          message: 'Restrictions need a condition, like {0 < x < 5}.',
          span: cond.span,
        });
      }
      conditions.push(cond);
      if (at('comma')) {
        next();
        continue;
      }
      break;
    }
    if (!at('rbrace')) {
      fail({
        kind: 'unmatched-paren',
        message: 'This "{" is never closed.',
        span: open.span,
        suggestion: {
          label: 'Insert "}"',
          edit: { type: 'insert', at: source.length, text: '}' },
        },
      });
    }
    const close = next();
    result = {
      kind: 'restriction',
      body: expr,
      conditions,
      span: spanFrom(expr.span, close.span),
    };
  }

  if (peek().type !== 'eof') {
    const tok = peek();
    if (tok.type === 'rparen') {
      fail({
        kind: 'extra-paren',
        message: 'This ")" has no matching "(".',
        span: tok.span,
        suggestion: { label: 'Remove ")"', edit: { type: 'replace', span: tok.span, text: '' } },
      });
    }
    fail({
      kind: 'unexpected-token',
      message: `Unexpected "${tok.text}".`,
      span: tok.span,
    });
  }

  return result;

  /* ---------------------------------------------------------------- */

  function parseRelation(): Expr {
    const first = parseAdd();
    if (peek().type !== 'rel') return first;
    const operands: Expr[] = [first];
    const ops: RelOp[] = [];
    while (peek().type === 'rel') {
      ops.push(next().text as RelOp);
      operands.push(parseAdd());
    }
    return {
      kind: 'relation',
      operands,
      ops,
      span: spanFrom(operands[0].span, operands[operands.length - 1].span),
    };
  }

  function parseAdd(): Expr {
    let left = parseMul();
    while (at('op', '+') || at('op', '-')) {
      const op = next().text as '+' | '-';
      const right = parseMul();
      left = { kind: 'binary', op, left, right, span: spanFrom(left.span, right.span) };
    }
    return left;
  }

  function startsPrimary(tok: Token): boolean {
    switch (tok.type) {
      case 'num':
      case 'ident':
      case 'lparen':
      case 'lbracket':
        return true;
      case 'pipe':
        return absDepth === 0; // inside |…| a pipe closes, it doesn't start
      default:
        return false;
    }
  }

  function parseMul(): Expr {
    let left = parseUnary();
    for (;;) {
      if (at('op', '*') || at('op', '/')) {
        const op = next().text as '*' | '/';
        const right = parseUnary();
        left = { kind: 'binary', op, left, right, span: spanFrom(left.span, right.span) };
      } else if (startsPrimary(peek())) {
        const right = parseUnary();
        left = {
          kind: 'binary',
          op: '*',
          left,
          right,
          implicit: true,
          span: spanFrom(left.span, right.span),
        };
      } else {
        return left;
      }
    }
  }

  /** Implicit products only — used for paren-less function arguments. */
  function parseImplicitProduct(): Expr {
    let left = parseUnary();
    while (startsPrimary(peek())) {
      const right = parseUnary();
      left = {
        kind: 'binary',
        op: '*',
        left,
        right,
        implicit: true,
        span: spanFrom(left.span, right.span),
      };
    }
    return left;
  }

  function parseUnary(): Expr {
    if (at('op', '-') || at('op', '+')) {
      const tok = next();
      const operand = parseUnary();
      return {
        kind: 'unary',
        op: tok.text as '-' | '+',
        operand,
        span: spanFrom(tok.span, operand.span),
      };
    }
    return parsePower();
  }

  function parsePower(): Expr {
    const base = parsePostfix();
    if (at('op', '^')) {
      next();
      const exponent = parseUnary(); // right-assoc; allows x^-2
      return {
        kind: 'binary',
        op: '^',
        left: base,
        right: exponent,
        span: spanFrom(base.span, exponent.span),
      };
    }
    return base;
  }

  function parsePostfix(): Expr {
    let node = parsePrimary();
    while (at('op', '!')) {
      const bang = next();
      node = { kind: 'postfix', op: '!', operand: node, span: spanFrom(node.span, bang.span) };
    }
    return node;
  }

  function parsePrimary(): Expr {
    const tok = peek();

    if (tok.type === 'num') {
      next();
      return { kind: 'num', value: tok.value!, span: tok.span };
    }

    if (tok.type === 'ident') {
      next();
      if (tok.unknownWord) {
        // multi-letter run near a known function, followed by '('
        const guess = nearestName(tok.text, functions);
        fail({
          kind: 'unknown-function',
          message: `"${tok.text}" isn't a function.`,
          span: tok.span,
          suggestion: guess
            ? { label: `Did you mean ${guess}?`, edit: { type: 'replace', span: tok.span, text: guess } }
            : undefined,
        });
      }
      if (functions.has(tok.text)) return parseCall(tok);
      return { kind: 'ident', name: tok.text, span: tok.span };
    }

    if (tok.type === 'lparen') {
      const open = next();
      const first = parseRelation();
      if (at('comma')) {
        next();
        const second = parseRelation();
        if (at('comma')) {
          fail({
            kind: 'unexpected-token',
            message: 'Points have exactly two coordinates: (x, y).',
            span: peek().span,
          });
        }
        const close = expectClose(open);
        return { kind: 'point', x: first, y: second, span: spanFrom(open.span, close.span) };
      }
      const close = expectClose(open);
      return { ...first, span: spanFrom(open.span, close.span) };
    }

    if (tok.type === 'lbracket') {
      const open = next();
      const items: Expr[] = [];
      if (!at('rbracket')) {
        items.push(parseAdd());
        while (at('comma')) {
          next();
          items.push(parseAdd());
        }
      }
      if (!at('rbracket')) {
        fail({
          kind: 'unmatched-paren',
          message: 'This "[" is never closed.',
          span: open.span,
          suggestion: { label: 'Insert "]"', edit: { type: 'insert', at: source.length, text: ']' } },
        });
      }
      const close = next();
      return { kind: 'list', items, span: spanFrom(open.span, close.span) };
    }

    if (tok.type === 'lbrace') {
      return parsePiecewise();
    }

    if (tok.type === 'pipe' && absDepth === 0) {
      const open = next();
      absDepth++;
      const inner = parseAdd();
      absDepth--;
      if (!at('pipe')) {
        fail({
          kind: 'unterminated-abs',
          message: 'This "|" is never closed. (For nested absolute values, use abs().)',
          span: open.span,
          suggestion: { label: 'Insert "|"', edit: { type: 'insert', at: source.length, text: '|' } },
        });
      }
      const close = next();
      return {
        kind: 'call',
        callee: 'abs',
        args: [inner],
        parens: true,
        span: spanFrom(open.span, close.span),
      };
    }

    if (tok.type === 'eof') {
      fail({
        kind: 'unexpected-end',
        message: 'The expression ends too early.',
        span: tok.span,
      });
    }

    fail({ kind: 'unexpected-token', message: `Unexpected "${tok.text}".`, span: tok.span });
  }

  function parseCall(nameTok: Token): Expr {
    if (at('lparen')) {
      const open = next();
      const args: Expr[] = [parseAdd()];
      while (at('comma')) {
        next();
        args.push(parseAdd());
      }
      const close = expectClose(open);
      return {
        kind: 'call',
        callee: nameTok.text,
        args,
        parens: true,
        span: spanFrom(nameTok.span, close.span),
      };
    }
    if (startsPrimary(peek()) && !(peek().type === 'op')) {
      const arg = parseImplicitProduct();
      return {
        kind: 'call',
        callee: nameTok.text,
        args: [arg],
        parens: false,
        span: spanFrom(nameTok.span, arg.span),
      };
    }
    fail({
      kind: 'missing-argument',
      message: `${nameTok.text} needs an argument.`,
      span: nameTok.span,
      suggestion: {
        label: `Insert "(" after ${nameTok.text}`,
        edit: { type: 'insert', at: nameTok.span.end, text: '(' },
      },
    });
  }

  /**
   * `{cond: value, cond: value, fallback}` in primary position (a trailing
   * `{...}` after a complete expression is a restriction — handled at top
   * level). `{cond}` without a value is the Desmos shorthand for 1-where-true.
   */
  function parsePiecewise(): Expr {
    const open = next(); // lbrace
    const branches: Array<{ condition: Relation; value: Expr }> = [];
    let fallback: Expr | undefined;
    for (;;) {
      const item = parseRelation();
      if (at('colon')) {
        next();
        if (item.kind !== 'relation') {
          fail({
            kind: 'not-a-condition',
            message: 'Before ":" needs a condition, like {x < 0: -x}.',
            span: item.span,
          });
        }
        branches.push({ condition: item, value: parseAdd() });
      } else if (item.kind === 'relation') {
        // shorthand: {x > 0} = 1 where the condition holds
        branches.push({ condition: item, value: { kind: 'num', value: 1, span: item.span } });
      } else {
        fallback = item;
        if (at('comma')) {
          fail({
            kind: 'unexpected-token',
            message: 'The fallback must be the last item in a piecewise.',
            span: peek().span,
          });
        }
      }
      if (at('comma')) {
        next();
        continue;
      }
      break;
    }
    if (!at('rbrace')) {
      fail({
        kind: 'unmatched-paren',
        message: 'This "{" is never closed.',
        span: open.span,
        suggestion: { label: 'Insert "}"', edit: { type: 'insert', at: source.length, text: '}' } },
      });
    }
    const close = next();
    return {
      kind: 'piecewise',
      branches,
      fallback,
      span: spanFrom(open.span, close.span),
    };
  }

  function expectClose(open: Token): Token {
    if (!at('rparen')) {
      fail({
        kind: 'unmatched-paren',
        message: 'This "(" is never closed.',
        span: open.span,
        suggestion: { label: 'Insert ")"', edit: { type: 'insert', at: source.length, text: ')' } },
      });
    }
    return next();
  }
}
