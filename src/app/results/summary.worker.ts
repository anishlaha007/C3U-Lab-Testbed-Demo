/// <reference lib="webworker" />
/**
 * Race-series statistics off the main thread: a quick M3 series already means ~70 pairwise
 * permutation tests (2,000 permutations each) plus bootstrap CIs, a few hundred ms in the browser,
 * and the Results tab refreshes them while the series is still running.
 */
import * as Comlink from 'comlink';
import { summariseRaceSeries, type TrialRecord } from '../../core/experiments';
import type { Weights } from '../../core/metrics/scorecard';

const api = {
  race(recs: TrialRecord[], weights?: Weights) {
    return summariseRaceSeries(recs, weights);
  },
};

export type SummaryApi = typeof api;
Comlink.expose(api);
