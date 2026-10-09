/** Course editor (filled in the course phase). */
import { useStore } from '../store';

export function CourseEditor() {
  const close = useStore((s) => s.setEditorOpen);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => close(false)}>
      <div className="rounded bg-white p-4 text-sm dark:bg-slate-900">Course editor coming in a later phase.</div>
    </div>
  );
}
