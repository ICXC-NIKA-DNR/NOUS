// Shared name tables. Both the lexer (for identifier segmentation) and the
// evaluator (for lookup) use these — keep them in one place.

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
};

// Unicode characters accepted in input, normalized to ASCII names/operators.
export const UNICODE_NAMES: Record<string, string> = {
  'π': 'pi',
  'τ': 'tau',
  'θ': 'theta',
  'φ': 'phi',
};

export const FUNCTION_NAMES: readonly string[] = [
  // trig
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot',
  'asin', 'acos', 'atan', 'arcsin', 'arccos', 'arctan',
  // hyperbolic
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  // exp / log
  'exp', 'ln', 'log', 'log2', 'sqrt', 'cbrt',
  // misc
  'abs', 'floor', 'ceil', 'round', 'sign',
  'min', 'max', 'mod', 'gcd', 'lcm',
];

/** Multi-letter words the lexer should treat as single identifiers. */
export function defaultKnownNames(): Set<string> {
  const s = new Set<string>(FUNCTION_NAMES);
  for (const c of Object.keys(CONSTANTS)) s.add(c);
  s.add('theta'); // conventional polar variable — a free variable, not a constant
  return s;
}
