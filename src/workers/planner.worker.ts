/// <reference lib="webworker" />
/** Game solving off the main thread (Section 7.3): candidate generation, rollouts, solvers. */
import * as Comlink from 'comlink';
import { solvePlan } from '../core/planners/plan';
import type { PlanResult } from '../core/planners/types';
import type { SimConfig } from '../core/types';

const api = {
  solve(cfg: SimConfig, onProgress?: (f: number, msg: string) => void): PlanResult {
    return solvePlan(cfg, { onProgress: (f, m) => onProgress?.(f, m) });
  },
};

export type PlannerApi = typeof api;
Comlink.expose(api);
