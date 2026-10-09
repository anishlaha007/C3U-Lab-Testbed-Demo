/**
 * Results tab (Section 10.1): the experiment launcher and the tables / charts of the milestone
 * experiments (M1 tracking, M2 safety, M3 racing) and of the recorded live trials. The section
 * follows the app mode, and jumps to an experiment's section when a run starts elsewhere (e.g. from
 * a milestone narration card).
 */
import { useEffect, useRef, useState } from 'react';
import type { ExperimentKind } from '../../core/experiments';
import { useExperiments } from '../experiments';
import { ExperimentLauncher, sectionOfKind, type Section } from '../results/ExperimentLauncher';
import { M1Results } from '../results/M1Results';
import { M2Results } from '../results/M2Results';
import { M3Results } from '../results/M3Results';
import { TrialsResults } from '../results/TrialsResults';
import { useStore, type Mode } from '../store';
import { Tabs } from '../ui';

const SECTIONS: { value: Section; label: string; title: string }[] = [
  { value: 'm1', label: 'M1 tracking', title: 'Speed sweep and streamed / uploaded / PID-like comparison' },
  { value: 'm2', label: 'M2 safety', title: 'Safety sweep, margin sweep and drone-count scaling' },
  { value: 'm3', label: 'M3 racing', title: 'Race series under the game-theoretic planners' },
  { value: 'trials', label: 'Trials', title: 'Recorded live trials ranked by composite score' },
];

const sectionOfMode = (m: Mode): Section => (m === 'm1' || m === 'm2' || m === 'm3' ? m : 'trials');

/** "kind@startedAt" of the most recently started run (a primitive, so the selector is stable). */
function latestStart(runs: Partial<Record<ExperimentKind, { startedAt: number }>>): string {
  let best = '';
  let t = -Infinity;
  for (const [k, r] of Object.entries(runs)) if (r && r.startedAt > t) [best, t] = [`${k}@${r.startedAt}`, r.startedAt];
  return best;
}

export function ResultsTab() {
  const mode = useStore((s) => s.mode);
  const [section, setSection] = useState<Section>(() => sectionOfMode(mode));
  useEffect(() => setSection(sectionOfMode(mode)), [mode]);
  const latest = useExperiments((s) => latestStart(s.runs));
  const seen = useRef(latest);
  useEffect(() => {
    if (latest && latest !== seen.current) setSection(sectionOfKind(latest.split('@')[0] as ExperimentKind));
    seen.current = latest;
  }, [latest]);
  return (
    <div className="space-y-2.5">
      <div className="sticky -top-2.5 z-10 -mx-2.5 -mt-2.5 border-b border-slate-200 bg-slate-50/95 px-2.5 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <Tabs small value={section} options={SECTIONS} onChange={setSection} />
      </div>
      <ExperimentLauncher section={section} />
      {section === 'm1' && <M1Results />}
      {section === 'm2' && <M2Results />}
      {section === 'm3' && <M3Results />}
      {section === 'trials' && <TrialsResults />}
    </div>
  );
}
