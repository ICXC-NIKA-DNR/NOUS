// Tokenizer. Notable behaviors (all covered by tests — see lexer.test.ts):
//
// * Identifier segmentation: a run of letters is greedily matched against the
//   known-name table (builtin functions, constants, user-declared names);
//   unmatched letters split into single-letter variables. `pixel` → pi·x·e·l,
//   `xy` → x·y. This is what makes `2xy` mean 2·x·y, like Desmos.
// * Subscripts: `a_1`, `R_oc` lex as single identifiers.
// * Typo capture: a multi-letter run that matches nothing but is followed by
//   `(` and is within edit distance of a known function is kept whole and
//   flagged `unknownWord`, so the parser can suggest the correction.
// * Unicode: π τ θ φ, · × for multiplication, − for minus, ≤ ≥ for relations.
// * Scientific notation: `1e-3` works; a lone `e` is still Euler's constant.

import type { Span } from './ast.ts';
import { fail, nearestName } from './errors.ts';
import { defaultKnownNames, FUNCTION_NAMES, UNICODE_NAMES } from './names.ts';

export type TokenType =
  | 'num'
  | 'ident'
  | 'op' // + - * / ^ !
  | 'rel' // < <= > >= =
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'colon'
  | 'pipe'
  | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  span: Span;
  value?: number; // for 'num'
  /** Multi-letter run that matched no known name (kept whole for a typo hint). */
  unknownWord?: boolean;
}

export interface LexOptions {
  /**
   * Extra multi-letter names to treat as single identifiers (user-defined
   * functions/variables). Single letters never need declaring.
   */
  extraNames?: Iterable<string>;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isAlnum = (c: string) => isDigit(c) || isLetter(c);

export function lex(source: string, options: LexOptions = {}): Token[] {
  const known = defaultKnownNames();
  const functionNames = new Set<string>(FUNCTION_NAMES);
  if (options.extraNames) {
    for (const n of options.extraNames) {
      known.add(n);
      functionNames.add(n);
    }
  }
  // Longest-first list for greedy matching.
  const knownByLength = [...known].sort((a, b) => b.length - a.length);

  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, start: number, end: number, extra?: Partial<Token>) =>
    tokens.push({ type, text: source.slice(start, end), span: { start, end }, ...extra });

  /** Attach a `_subscript` to an identifier name if one follows position `pos`. */
  const readSubscript = (pos: number): number => {
    if (source[pos] !== '_') return pos;
    let j = pos + 1;
    if (!isAlnum(source[j] ?? '')) return pos; // a trailing bare `_` is not a subscript
    while (j < source.length && isAlnum(source[j])) j++;
    return j;
  };

  while (i < source.length) {
    const c = source[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // numbers: 12, 1.5, .5, 2e-3
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      while (i < source.length && isDigit(source[i])) i++;
      if (source[i] === '.') {
        i++;
        if (!isDigit(source[i] ?? '')) {
          fail({
            kind: 'invalid-number',
            message: `Number "${source.slice(start, i)}" is missing digits after the decimal point.`,
            span: { start, end: i },
            suggestion: { label: 'Insert "0"', edit: { type: 'insert', at: i, text: '0' } },
          });
        }
        while (i < source.length && isDigit(source[i])) i++;
      }
      // exponent — only when digits actually follow, so `2e` stays 2·e
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j++;
        if (isDigit(source[j] ?? '')) {
          j++;
          while (j < source.length && isDigit(source[j])) j++;
          i = j;
        }
      }
      const text = source.slice(start, i);
      push('num', start, i, { value: Number(text) });
      continue;
    }

    // unicode names → ascii identifier
    if (c in UNICODE_NAMES) {
      const start = i;
      i++;
      const end = readSubscript(i);
      const sub = source.slice(i, end); // includes leading '_' if present
      i = end;
      tokens.push({
        type: 'ident',
        text: UNICODE_NAMES[c] + sub,
        span: { start, end: i },
      });
      continue;
    }

    // letter runs → segmentation
    if (isLetter(c)) {
      const runStart = i;
      while (i < source.length && isLetter(source[i])) i++;
      const run = source.slice(runStart, i);

      // Typo capture: whole run (3+ letters — two-letter runs are usually
      // genuine products like a·b), unknown, followed by '(' and near a
      // known function name.
      let k = i;
      while (source[k] === ' ') k++;
      if (
        run.length >= 3 &&
        !known.has(run) &&
        source[k] === '(' &&
        nearestName(run, functionNames) !== null
      ) {
        push('ident', runStart, i, { unknownWord: true });
        continue;
      }

      // Greedy longest-known-name segmentation; leftovers are single letters.
      let pos = 0;
      while (pos < run.length) {
        const segStart = runStart + pos;
        let matched: string | null = null;
        for (const name of knownByLength) {
          if (name.length > 1 && run.startsWith(name, pos)) {
            matched = name;
            break;
          }
        }
        const seg = matched ?? run[pos];
        pos += seg.length;
        let end = runStart + pos;
        // subscript only attaches to the final segment of the run
        if (pos === run.length) {
          end = readSubscript(end);
          i = end;
        }
        tokens.push({
          type: 'ident',
          text: source.slice(segStart, end),
          span: { start: segStart, end },
        });
      }
      continue;
    }

    const start = i;
    const two = source.slice(i, i + 2);
    if (two === '<=' || two === '>=') {
      i += 2;
      push('rel', start, i);
      continue;
    }

    switch (c) {
      case '≤':
        i++;
        tokens.push({ type: 'rel', text: '<=', span: { start, end: i } });
        continue;
      case '≥':
        i++;
        tokens.push({ type: 'rel', text: '>=', span: { start, end: i } });
        continue;
      case '<':
      case '>':
      case '=':
        i++;
        push('rel', start, i);
        continue;
      case '+':
      case '/':
      case '^':
      case '!':
        i++;
        push('op', start, i);
        continue;
      case '-':
      case '−':
        i++;
        tokens.push({ type: 'op', text: '-', span: { start, end: i } });
        continue;
      case '*':
      case '·':
      case '×':
        i++;
        tokens.push({ type: 'op', text: '*', span: { start, end: i } });
        continue;
      case '(':
        i++;
        push('lparen', start, i);
        continue;
      case ')':
        i++;
        push('rparen', start, i);
        continue;
      case '{':
        i++;
        push('lbrace', start, i);
        continue;
      case '}':
        i++;
        push('rbrace', start, i);
        continue;
      case '[':
        i++;
        push('lbracket', start, i);
        continue;
      case ']':
        i++;
        push('rbracket', start, i);
        continue;
      case ',':
        i++;
        push('comma', start, i);
        continue;
      case ':':
        i++;
        push('colon', start, i);
        continue;
      case '|':
        i++;
        push('pipe', start, i);
        continue;
      default:
        fail({
          kind: 'unexpected-token',
          message: `Unexpected character "${c}".`,
          span: { start: i, end: i + 1 },
          suggestion: {
            label: `Remove "${c}"`,
            edit: { type: 'replace', span: { start: i, end: i + 1 }, text: '' },
          },
        });
    }
  }

  tokens.push({ type: 'eof', text: '', span: { start: source.length, end: source.length } });
  return tokens;
}
