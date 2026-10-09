/** Re-render on live ticks and trial rebuilds. */
import { useSyncExternalStore } from 'react';
import { engine } from '../engine';
import { useStore } from '../store';

export function useLive(): { tick: number; generation: number } {
  const tick = useStore((s) => s.liveTick);
  const generation = useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.generation * 10 + (engine.status === 'done' ? 1 : 0) + (engine.replayTime !== null ? 2 : 0),
  );
  return { tick, generation };
}
