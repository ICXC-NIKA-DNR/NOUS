// M3 performance harness (PLAN.md acceptance gate). Open the app with
// ?perf=50 to load 50 slider-bound expressions; press ▶ on the HUD to
// animate two sliders at refresh rate — a stricter version of "dragging a
// slider stays smooth". The HUD shows rolling fps / frame ms / resample
// counts, and the same line is logged to the console once per second.

import { useCallback, useEffect, useRef } from 'react';
import type { FrameStats } from './GraphCanvas.tsx';
import {
  applyCommand,
  flattenExpressions,
  makeExpression,
  type GcalcDocument,
  type Item,
} from '../state/document.ts';
import { definitionName } from './analyze.ts';

function perfCount(): number {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('perf'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const SLIDERS: Array<[string, number]> = [
  ['a', 1],
  ['b', 1],
  ['c', 2],
  ['d', 0.5],
  ['k', 3],
];

/** Curve templates cycled to fill the requested count. a and b animate. */
const TEMPLATES: Array<(i: number) => string> = [
  (i) => `y = a sin(x + ${i}/10)`,
  (i) => `y = b cos(${(i % 7) + 1} x / 4)`,
  (i) => `y = c x^2 / ${i + 10} - d`,
  (i) => `y = a exp(-x^2 / ${i + 5})`,
  (i) => `y = d tan(x / ${(i % 5) + 2})`,
  (i) => `y = (a x^3 - b x) / ${i + 20}`,
  (i) => `y = k sqrt(|x|) + ${i}/8`,
  (i) => `y = b / (x - ${(i % 9) - 4})`,
];

/**
 * The M4 acceptance gallery (?gallery=1): every plot type, restriction
 * syntax exercised on each family.
 */
const GALLERY: string[] = [
  'y = sin(x) {x > -8}',
  'y = 1/x',
  '{x < 0: -x - 6, x^2/4 - 6}',
  '(4cos(3t), 4sin(2t)) {0 < t < 2pi}',
  'r = 2 + 2cos(theta)',
  'r = 5cos(3theta) {0 < theta < pi}',
  'x^2 + y^2 = 25',
  'sin(x) = cos(y)',
  '9 < x^2 + y^2 <= 25 {y < 0}',
  'y <= -x - 4 {x < -2}',
  'x = 7',
  '(6, 4)',
  '[(-7, 5), (-6, 5.5), (-5, 5.2), (-4, 6)]',
  'vector((5, -3), (7, -1))',
  '(-y/4, x/4)',
];

/** The ?gallery=1 document items, or null in normal operation. */
export function galleryItems(): Item[] | null {
  if (typeof location === 'undefined') return null;
  if (new URLSearchParams(location.search).get('gallery') === null) return null;
  return GALLERY.map((src) => makeExpression(src));
}

/** The ?perf=N document items, or null in normal operation. */
export function perfItems(): Item[] | null {
  const n = perfCount();
  if (n === 0) return null;
  const items: Item[] = SLIDERS.map(([name, value]) =>
    makeExpression(`${name} = ${value}`, { min: -10, max: 10, step: 0.1 }),
  );
  for (let i = 0; i < n; i++) {
    items.push(makeExpression(TEMPLATES[i % TEMPLATES.length](i)));
  }
  return items;
}

type SetDocument = React.Dispatch<React.SetStateAction<GcalcDocument>>;

interface PerfAnimation {
  hudRef: React.RefObject<HTMLDivElement>;
  onFrame: ((stats: FrameStats) => void) | undefined;
  /** Start/stop the slider animation; returns the new running state. */
  toggle: () => boolean;
}

export function usePerfAnimation(setDoc: SetDocument): PerfAnimation {
  const active = perfCount() > 0;
  const hudRef = useRef<HTMLDivElement>(null);
  // Phase 1: measure the webview's idle rAF cadence (the fps ceiling this
  // compositor allows). Phase 2: auto-start the animation and compare.
  const running = useRef(false);
  const baseline = useRef<{ frames: number; fps: number }>({ frames: 0, fps: 0 });
  const stats = useRef<FrameStats>({ frameMs: 0, resampled: 0, cached: 0 });
  const frames = useRef<{ times: number[]; ms: number[]; last: number; sinceLog: number }>({
    times: [],
    ms: [],
    last: 0,
    sinceLog: 0,
  });

  const onFrame = useCallback((s: FrameStats): void => {
    stats.current = s;
  }, []);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const fr = frames.current;

      // Baseline phase: 60 idle frames measuring pure rAF cadence.
      const bl = baseline.current;
      if (bl.fps === 0) {
        bl.frames++;
        if (bl.frames === 60) {
          const avgDelta = fr.times.reduce((s, t2) => s + t2, 0) / Math.max(1, fr.times.length);
          bl.fps = 1000 / avgDelta;
          console.log(`[perf] baseline idle fps=${bl.fps.toFixed(1)} (compositor ceiling)`);
          fr.times.length = 0;
          fr.ms.length = 0;
          running.current = true; // phase 2
        }
      }

      if (running.current) {
        // Simulate a user drag: one slider sweeps at a time (that's what
        // "dragging stays smooth" gates), alternating a / b every 4s so both
        // dependency sets get exercised. Writes straight to the document
        // (never through undo history — this is an automated animation).
        const t = now / 1000;
        const which = Math.floor(t / 4) % 2 === 0 ? 'a' : 'b';
        const value = ((which === 'a' ? 5 : 3) * Math.sin(t * 2)).toFixed(2);
        setDoc((d) => {
          const target = flattenExpressions(d).find(
            ({ item }) => definitionName(item.source) === which,
          );
          if (!target) return d;
          return applyCommand(d, { type: 'edit', id: target.item.id, source: `${which} = ${value}` });
        });
      }

      if (fr.last > 0) {
        const delta = now - fr.last;
        fr.times.push(delta);
        fr.ms.push(stats.current.frameMs);
        if (fr.times.length > 60) {
          fr.times.shift();
          fr.ms.shift();
        }
        fr.sinceLog += delta;
        const avgDelta = fr.times.reduce((s, t2) => s + t2, 0) / fr.times.length;
        const fps = 1000 / avgDelta;
        const worst = Math.max(...fr.times);
        const avgMs = fr.ms.reduce((s, m) => s + m, 0) / fr.ms.length;
        const maxMs = Math.max(...fr.ms);
        const bl2 = baseline.current;
        const line =
          `${running.current ? '▶' : '⏸'} ${fps.toFixed(0)} fps` +
          `${bl2.fps > 0 ? ` (idle ceiling ${bl2.fps.toFixed(0)})` : ' measuring baseline…'}  ` +
          `worst gap ${worst.toFixed(0)}ms\n` +
          `draw avg ${avgMs.toFixed(1)}ms max ${maxMs.toFixed(1)}ms  ` +
          `resample ${stats.current.resampled}/${stats.current.resampled + stats.current.cached}`;
        if (hudRef.current) {
          const label = hudRef.current.querySelector('.perf-line');
          if (label) label.textContent = line;
        }
        if (fr.sinceLog >= 1000) {
          fr.sinceLog = 0;
          // The frame-budget log the M3 acceptance criteria ask for.
          console.log(
            `[perf] fps=${fps.toFixed(1)} idleCeiling=${bl2.fps.toFixed(1)} ` +
              `worstGap=${worst.toFixed(1)}ms ` +
              `draw(avg=${avgMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms) ` +
              `resampled=${stats.current.resampled} cached=${stats.current.cached}`,
          );
        }
      }
      fr.last = now;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, setDoc]);

  const toggle = useCallback((): boolean => {
    running.current = !running.current;
    return running.current;
  }, []);

  return { hudRef, onFrame: active ? onFrame : undefined, toggle };
}

export function PerfHud({
  hudRef,
  toggle,
}: {
  hudRef: React.RefObject<HTMLDivElement>;
  toggle: () => boolean;
}): JSX.Element | null {
  if (perfCount() === 0) return null;
  return (
    <div className="perf-hud" ref={hudRef}>
      <pre className="perf-line">waiting for frames…</pre>
      <button
        type="button"
        onClick={(e) => {
          e.currentTarget.textContent = toggle() ? '⏸ stop' : '▶ animate sliders';
        }}
      >
        ⏸ stop
      </button>
    </div>
  );
}
