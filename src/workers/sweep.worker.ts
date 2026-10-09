/// <reference lib="webworker" />
/**
 * Experiment worker (Section 12): flies trial specs headlessly. The app runs a pool of these and
 * hands out one spec at a time, so results do not depend on the number of workers.
 */
import * as Comlink from 'comlink';
import { runTrialSpec, soloRmses, type TrialRecord, type TrialSpec } from '../core/experiments';
import type { Weights } from '../core/metrics/scorecard';
import type { SimConfig, Trajectory } from '../core/types';

const api = {
  run(spec: TrialSpec, weights: Weights): TrialRecord {
    return runTrialSpec(spec, weights);
  },
  solo(cfg: SimConfig, trajectories: Trajectory[], weights: Weights): number[] {
    return soloRmses(cfg, trajectories, weights);
  },
};

export type SweepApi = typeof api;
Comlink.expose(api);
