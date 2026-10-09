import { useEffect, useState } from 'react';
import { HONESTY_LABEL } from '../core/constants';
import { SceneRoot } from './scene/SceneRoot';

export default function App() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-300 bg-white/80 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950/80">
        <span className="font-semibold">C3U Multi-Drone Racing Testbed</span>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">{HONESTY_LABEL}</span>
        <button className="ml-auto rounded border px-2 py-0.5 text-xs dark:border-slate-700" onClick={() => setDark((d) => !d)}>
          {dark ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="relative min-h-0 flex-1">
        <SceneRoot dark={dark} />
      </main>
    </div>
  );
}
