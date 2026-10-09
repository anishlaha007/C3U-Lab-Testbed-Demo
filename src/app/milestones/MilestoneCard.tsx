/**
 * Guided narration card (Section 12): a floating panel over the 3D view with 3 to 5 short steps
 * per guided mode, step dots and Back / Next. The step lives in the store (narrationStep; setMode
 * resets it to 0). Entering a step runs its `enter` action once (preset, camera, right tab, fly or
 * an experiment); re-renders never re-apply it, so whatever the user changes afterwards stays.
 * Sits below the camera buttons and above the honesty label; toasts stack above it (z-40).
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { cx } from '../ui';
import { GUIDES, NEXT_MODE } from './guides';

export function MilestoneCard() {
  const mode = useStore((s) => s.mode);
  const step = useStore((s) => s.narrationStep);
  const setStep = useStore((s) => s.setNarrationStep);
  const setMode = useStore((s) => s.setMode);
  const [collapsed, setCollapsed] = useState(false);
  const guide = mode === 'sandbox' ? null : GUIDES[mode];
  const n = guide?.steps.length ?? 0;
  const k = Math.max(0, Math.min(step, n - 1));
  const entered = useRef('');
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!guide) return;
    const key = `${guide.mode}:${k}`;
    // StrictMode runs effects twice; a step is entered once per visit
    if (entered.current === key) return;
    entered.current = key;
    guide.steps[k].enter?.();
    body.current?.scrollTo({ top: 0 });
  }, [guide, k]);

  if (!guide) return null;
  const st = guide.steps[k];
  const next = NEXT_MODE[guide.mode];
  const last = k === n - 1;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Show the guide"
        className="absolute top-9 left-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full border border-slate-300/80 bg-white/85 px-3 py-1 text-[11px] shadow-lg backdrop-blur-md hover:bg-white dark:border-slate-700/80 dark:bg-slate-950/80 dark:hover:bg-slate-900"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
        <span className="font-semibold text-sky-700 dark:text-sky-300">{guide.label}</span>
        <span className="tabular text-slate-500">
          {k + 1}/{n}
        </span>
        <span className="truncate text-slate-700 dark:text-slate-300">{st.title}</span>
        <span className="text-slate-400">▸</span>
      </button>
    );
  }

  return (
    <section
      aria-label={`${guide.label} guide`}
      className="absolute top-9 left-2 z-20 flex max-h-[calc(100%-5.25rem)] w-[404px] max-w-[calc(100%-1rem)] flex-col rounded-lg border border-slate-300/80 bg-white/85 shadow-xl backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-950/80"
    >
      <header className="flex items-start gap-2 px-3 pt-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-400">{guide.label}</div>
          <div className="text-[13px] leading-tight font-semibold text-slate-900 dark:text-slate-100">{guide.title}</div>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse the guide"
          className="-mr-1 rounded px-1.5 text-base leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          –
        </button>
      </header>
      <nav className="flex items-center gap-1 px-3 pt-1.5 pb-2" aria-label="Steps">
        {guide.steps.map((s, i) => (
          <button
            key={i}
            onClick={() => setStep(i)}
            title={s.title}
            aria-current={i === k ? 'step' : undefined}
            className={cx(
              'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold transition-colors',
              i === k ? 'bg-sky-600 text-white' : i < k ? 'bg-sky-100 text-sky-800 hover:bg-sky-200 dark:bg-sky-500/20 dark:text-sky-300 dark:hover:bg-sky-500/30' : 'bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700',
            )}
          >
            {i + 1}
          </button>
        ))}
        <span className="ml-1.5 min-w-0 flex-1 text-[11.5px] leading-tight font-medium text-slate-800 dark:text-slate-200">
          {st.title}
        </span>
      </nav>
      <div ref={body} className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <st.Body key={`${guide.mode}:${k}`} />
      </div>
      <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-1.5 dark:border-slate-800">
        <button
          onClick={() => setStep(k - 1)}
          disabled={k === 0}
          className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-800"
        >
          ← Back
        </button>
        <span className="tabular flex-1 text-center text-[10px] text-slate-500">
          Step {k + 1} of {n}
        </span>
        {last ? (
          next ? (
            <button onClick={() => setMode(next)} className="rounded bg-sky-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500">
              {GUIDES[next].label} →
            </button>
          ) : (
            <button onClick={() => setMode('sandbox')} className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800">
              Back to sandbox
            </button>
          )
        ) : (
          <button onClick={() => setStep(k + 1)} className="rounded bg-sky-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500">
            Next →
          </button>
        )}
      </footer>
    </section>
  );
}
