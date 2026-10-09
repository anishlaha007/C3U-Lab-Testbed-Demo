/** Colour legend for speed-coloured trails (same map as the trail ribbons). */
import { useStore } from '../store';
import { speedColor } from './Trail';
import { trailSpeedMax, useEngineGeneration } from './SceneRoot';

const STOPS = 6;

export function SpeedLegend() {
  useEngineGeneration();
  const show = useStore((s) => s.visuals.trails && s.visuals.trailColor === 'speed');
  if (!show) return null;
  const vmax = trailSpeedMax();
  const gradient = Array.from({ length: STOPS }, (_, i) => `#${speedColor((i / (STOPS - 1)) * vmax, vmax).getHexString()}`).join(', ');
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-10 rounded bg-white/70 px-2 py-1 text-[10px] text-slate-600 backdrop-blur dark:bg-slate-900/70 dark:text-slate-400">
      <div className="mb-0.5">trail speed (m/s)</div>
      <div className="h-1.5 w-32 rounded-sm" style={{ background: `linear-gradient(to right, ${gradient})` }} />
      <div className="flex justify-between font-mono">
        <span>0</span>
        <span>{(vmax / 2).toFixed(1)}</span>
        <span>{vmax.toFixed(1)}</span>
      </div>
    </div>
  );
}
