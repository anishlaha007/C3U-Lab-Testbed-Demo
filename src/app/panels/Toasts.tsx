import { useStore } from '../store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 z-40 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto cursor-pointer rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur ${
            t.kind === 'error'
              ? 'border-rose-400 bg-rose-50/95 text-rose-900 dark:bg-rose-950/90 dark:text-rose-200'
              : t.kind === 'warning'
                ? 'border-amber-400 bg-amber-50/95 text-amber-900 dark:bg-amber-950/90 dark:text-amber-200'
                : t.kind === 'success'
                  ? 'border-emerald-400 bg-emerald-50/95 text-emerald-900 dark:bg-emerald-950/90 dark:text-emerald-200'
                  : 'border-slate-300 bg-white/95 text-slate-800 dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
