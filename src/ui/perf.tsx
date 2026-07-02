// M3 performance harness (PLAN.md acceptance gate). Open the app with
// ?perf=50 to load 50 slider-bound expressions; press ▶ on the HUD to
// animate two sliders at refresh rate — a stricter version of "dragging a
// slider stays smooth". The HUD shows rolling fps / frame ms / resample
// counts, and the same line is logged to the console once per second.

import { useCallback, useEffect, useRef } from 'react';
import type { FrameStats } from './GraphCanvas.tsx';
import type { ExpressionEntry, SliderMeta } from './ExpressionRow.tsx';
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

/** The ?perf=N document, or null in normal operation. */
export function perfEntries(
  make: (source: string, slider?: SliderMeta) => ExpressionEntry,
): ExpressionEntry[] | null {
  const n = perfCount();
  if (n === 0) return null;
  const entries = SLIDERS.map(([name, value]) =>
    make(`${name} = ${value}`, { min: -10, max: 10, step: 0.1 }),
  );
  for (let i = 0; i < n; i++) {
    entries.push(make(TEMPLATES[i % TEMPLATES.length](i)));
  }
  return entries;
}

type SetEntries = React.Dispatch<React.SetStateAction<ExpressionEntry[]>>;

interface PerfAnimation {
  hudRef: React.RefObject<HTMLDivElement>;
  onFrame: ((stats: FrameStats) => void) | undefined;
  /** Start/stop the slider animation; returns the new running state. */
  toggle: () => boolean;
}

export function usePerfAnimation(setEntries: SetEntries): PerfAnimation {
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
        // dependency sets get exercised.
        const t = now / 1000;
        const which = Math.floor(t / 4) % 2 === 0 ? 'a' : 'b';
        const value = ((which === 'a' ? 5 : 3) * Math.sin(t * 2)).toFixed(2);
        setEntries((es) =>
          es.map((e) =>
            definitionName(e.source) === which ? { ...e, source: `${which} = ${value}` } : e,
          ),
        );
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
  }, [active, setEntries]);

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
