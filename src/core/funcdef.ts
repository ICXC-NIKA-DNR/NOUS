// Function-definition head pre-scan (M9.5.1). Purely textual, head-anchored:
// it reads `name(params) =` at the START of a row to harvest the function
// name and its parameters — WITHOUT parsing the expression. This breaks the
// chicken-and-egg: the harvested names feed the real lex/parse (as callable
// names) so that `f(9)` parses as a call everywhere, including the very row
// that defines `f`.
//
// This is a name harvester, NOT a second expression parser. It matches only
// the definition head and stops at the `=`; the body is never inspected here.
//
// Grammar (no implicit multiplication, no cleverness):
//   leading spaces? , letter-run name , '(' , single-letter params (distinct,
//   comma-separated, spaces allowed around each) , ')' , spaces? , '=' (a lone
//   '=', not part of '==' / '<=' / '>=')
//
// Space between the name and '(' breaks it (`f (x) =` is NOT a definition) —
// the same rule that keeps a bare `f x` from being function application, so
// defining and calling read consistently.

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

export interface FunctionHead {
  name: string;
  params: string[];
}

export function scanFunctionHead(source: string): FunctionHead | null {
  let i = 0;
  const n = source.length;
  while (i < n && source[i] === ' ') i++;

  const nameStart = i;
  while (i < n && isLetter(source[i])) i++;
  if (i === nameStart) return null; // no name
  const name = source.slice(nameStart, i);

  if (source[i] !== '(') return null; // immediate paren required (no space)
  i++;

  const params: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    while (i < n && source[i] === ' ') i++;
    if (!isLetter(source[i] ?? '')) return null; // need a single-letter param
    const p = source[i];
    i++;
    // A multi-letter param (`f(ab) = …`) is not a valid definition head.
    if (isLetter(source[i] ?? '')) return null;
    if (seen.has(p)) return null; // params must be distinct
    seen.add(p);
    params.push(p);
    while (i < n && source[i] === ' ') i++;
    if (source[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  if (source[i] !== ')') return null;
  i++;

  while (i < n && source[i] === ' ') i++;
  // A lone '=' (assignment), not '==', '<=', '>='.
  if (source[i] !== '=' || source[i + 1] === '=') return null;
  return { name, params };
}
