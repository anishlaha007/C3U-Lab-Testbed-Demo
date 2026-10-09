/** Right panel with the Live, Tracking, Safety, Race, Game and Results tabs. */
import { lazy, Suspense } from 'react';
import { useStore, type RightTab } from '../store';
import { Tabs } from '../ui';
import { LiveTab } from './LiveTab';
import { SafetyTab } from './SafetyTab';
import { TrackingTab } from './TrackingTab';

const RaceTab = lazy(() => import('./RaceTab').then((m) => ({ default: m.RaceTab })));
const GameTab = lazy(() => import('./GameTab').then((m) => ({ default: m.GameTab })));
const ResultsTab = lazy(() => import('./ResultsTab').then((m) => ({ default: m.ResultsTab })));

const TABS: { value: RightTab; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'tracking', label: 'Tracking' },
  { value: 'safety', label: 'Safety' },
  { value: 'race', label: 'Race' },
  { value: 'game', label: 'Game' },
  { value: 'results', label: 'Results' },
];

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);
  return (
    <aside className="flex w-[430px] shrink-0 flex-col border-l border-slate-300 bg-slate-50/90 dark:border-slate-800 dark:bg-slate-950/70">
      <div className="border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
        <Tabs small value={tab} options={TABS} onChange={setTab} />
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2.5">
        <Suspense fallback={<div className="text-xs text-slate-500">Loading…</div>}>
          {tab === 'live' && <LiveTab />}
          {tab === 'tracking' && <TrackingTab />}
          {tab === 'safety' && <SafetyTab />}
          {tab === 'race' && <RaceTab />}
          {tab === 'game' && <GameTab />}
          {tab === 'results' && <ResultsTab />}
        </Suspense>
      </div>
    </aside>
  );
}
