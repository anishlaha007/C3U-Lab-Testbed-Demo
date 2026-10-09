/**
 * Game solvers on the discretised strategy space (Section 7.3).
 *
 *  - Independent: each drone maximises its own progress, ignoring the other.
 *  - Nash: all pure-strategy equilibria of the M x M bimatrix game (each strategy a best response
 *    to the other); a tie-break rule picks one; with no pure equilibrium, iterated best response
 *    from the independent solution (cap 50 iterations).
 *  - Stackelberg: the leader picks i* = argmax_i payoff_L(i, BR_F(i)); the follower plays
 *    BR_F(i*) (ties in the follower's reply are broken in the leader's favour: strong
 *    Stackelberg).
 *  - N > 2 drones: Nash by sequential iterated best response over agents; Stackelberg as a
 *    priority chain (drone 1 leads all, drone 2 leads the rest, ...). Labelled as extensions.
 */
import type { GameMatrix } from './types';

const EPS = 1e-9;

/** best response of drone 1 to each column j, and of drone 2 to each row i (lowest index on ties). */
export function bestResponses(p1: number[][], p2: number[][], valid1: boolean[], valid2: boolean[]): { br1: number[]; br2: number[] } {
  const M1 = p1.length;
  const M2 = p1[0]?.length ?? 0;
  const br1: number[] = [];
  for (let j = 0; j < M2; j++) {
    let best = -1;
    for (let i = 0; i < M1; i++) if (valid1[i] && (best < 0 || p1[i][j] > p1[best][j] + EPS)) best = i;
    br1.push(best);
  }
  const br2: number[] = [];
  for (let i = 0; i < M1; i++) {
    let best = -1;
    for (let j = 0; j < M2; j++) if (valid2[j] && (best < 0 || p2[i][j] > p2[i][best] + EPS)) best = j;
    br2.push(best);
  }
  return { br1, br2 };
}

/** All pure Nash equilibria: cells where both strategies are best responses (within EPS). */
export function pureNash(p1: number[][], p2: number[][], valid1: boolean[], valid2: boolean[]): [number, number][] {
  const M1 = p1.length;
  const M2 = p1[0]?.length ?? 0;
  const colMax: number[] = [];
  for (let j = 0; j < M2; j++) {
    let m = -Infinity;
    for (let i = 0; i < M1; i++) if (valid1[i]) m = Math.max(m, p1[i][j]);
    colMax.push(m);
  }
  const rowMax: number[] = [];
  for (let i = 0; i < M1; i++) {
    let m = -Infinity;
    for (let j = 0; j < M2; j++) if (valid2[j]) m = Math.max(m, p2[i][j]);
    rowMax.push(m);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < M1; i++) {
    if (!valid1[i]) continue;
    for (let j = 0; j < M2; j++) {
      if (!valid2[j]) continue;
      if (p1[i][j] >= colMax[j] - EPS && p2[i][j] >= rowMax[i] - EPS) out.push([i, j]);
    }
  }
  return out;
}

/** Iterated best response from a start cell; returns the final cell and whether it converged. */
export function iteratedBestResponse(p1: number[][], p2: number[][], valid1: boolean[], valid2: boolean[], start: [number, number], cap = 50): { cell: [number, number]; converged: boolean; iterations: number } {
  const { br1, br2 } = bestResponses(p1, p2, valid1, valid2);
  let [i, j] = start;
  for (let it = 1; it <= cap; it++) {
    const ni = br1[j];
    const nj = br2[ni];
    if (ni === i && nj === j) return { cell: [i, j], converged: true, iterations: it };
    i = ni;
    j = nj;
  }
  return { cell: [i, j], converged: false, iterations: cap };
}

/** Strong Stackelberg: leader 0 (row player) or 1 (column player). */
export function stackelberg(p1: number[][], p2: number[][], valid1: boolean[], valid2: boolean[], leader: 0 | 1): [number, number] {
  const M1 = p1.length;
  const M2 = p1[0]?.length ?? 0;
  let best: [number, number] = [0, 0];
  let bestVal = -Infinity;
  if (leader === 0) {
    for (let i = 0; i < M1; i++) {
      if (!valid1[i]) continue;
      // follower's best replies, ties in favour of the leader
      let fBest = -Infinity;
      for (let j = 0; j < M2; j++) if (valid2[j]) fBest = Math.max(fBest, p2[i][j]);
      let j = -1;
      for (let jj = 0; jj < M2; jj++) if (valid2[jj] && p2[i][jj] >= fBest - EPS && (j < 0 || p1[i][jj] > p1[i][j])) j = jj;
      if (j >= 0 && p1[i][j] > bestVal + EPS) {
        bestVal = p1[i][j];
        best = [i, j];
      }
    }
  } else {
    for (let j = 0; j < M2; j++) {
      if (!valid2[j]) continue;
      let fBest = -Infinity;
      for (let i = 0; i < M1; i++) if (valid1[i]) fBest = Math.max(fBest, p1[i][j]);
      let i = -1;
      for (let ii = 0; ii < M1; ii++) if (valid1[ii] && p1[ii][j] >= fBest - EPS && (i < 0 || p2[ii][j] > p2[i][j])) i = ii;
      if (i >= 0 && p2[i][j] > bestVal + EPS) {
        bestVal = p2[i][j];
        best = [i, j];
      }
    }
  }
  return best;
}

/** Pick among several Nash equilibria. */
export function tieBreakNash(eq: [number, number][], m: Pick<GameMatrix, 'payoff1'> & { total: number[][] }, rule: 'maxTotal' | 'ego'): [number, number] {
  let best = eq[0];
  for (const c of eq) {
    const [i, j] = c;
    const [bi, bj] = best;
    if (rule === 'ego') {
      if (m.payoff1[i][j] > m.payoff1[bi][bj] + EPS || (Math.abs(m.payoff1[i][j] - m.payoff1[bi][bj]) <= EPS && m.total[i][j] > m.total[bi][bj])) best = c;
    } else if (m.total[i][j] > m.total[bi][bj] + EPS || (Math.abs(m.total[i][j] - m.total[bi][bj]) <= EPS && m.payoff1[i][j] > m.payoff1[bi][bj])) best = c;
  }
  return best;
}
