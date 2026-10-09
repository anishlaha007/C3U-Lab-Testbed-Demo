/**
 * Planner bridge: solves the game for the current configuration in a Web Worker and stores the
 * plan. Filled in by the planner phase; until then planner scenarios fly their default lines.
 */
import { useStore } from './store';

export function requestSolve(): void {
  const st = useStore.getState();
  st.toast('Planner not available yet.', 'warning');
}
