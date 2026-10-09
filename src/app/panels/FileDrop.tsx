/**
 * Trajectory file import (Section 5.5): drop the lab's per-drone CSVs (plus optional metadata
 * JSON) anywhere on the window, or pick them with the Import button. The files replace the
 * imported-trajectory registry and switch the scenario to "imported"; the engine then rebuilds
 * and the pre-flight validator decides whether they can fly (and says why not).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { DRONE_COLORS, DRONE_NAMES } from '../../core/constants';
import { CSV_COLUMNS, parseMetaJson, parseTrajectoryCsv, setImportedTrajectories } from '../../core/csv';
import type { Trajectory, TrajectoryMeta } from '../../core/types';
import { useStore } from '../store';
import { Button } from '../ui';

/** The arena flies at most six drones (A to F). */
const MAX_DRONES = 6;

interface TextFile {
  name: string;
  text: string;
}

interface CsvEntry extends TextFile {
  stem: string;
  hint: number | null;
  meta: Partial<TrajectoryMeta> | null;
}

interface MetaEntry {
  name: string;
  stem: string;
  meta: Partial<TrajectoryMeta>;
  used: boolean;
}

export interface ImportOutcome {
  trajectories: Trajectory[];
  /** Source file of each trajectory (same order). */
  sources: string[];
  errors: string[];
  /** Warnings keyed by message, with the files they apply to (so repeats collapse into one toast). */
  warnings: Map<string, string[]>;
}

const baseName = (name: string) => name.replace(/\.[^.]*$/, '');
const csvStem = (name: string) => baseName(name).toLowerCase();
// "run.meta.json" / "run_metadata.json" describe "run.csv"
const metaStem = (name: string) => csvStem(name).replace(/[._-]?meta(data)?$/, '');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Drone index hinted by a file name ("…_droneB", "drone-2", "uav1"). Letters follow DRONE_NAMES
 * (A = 0); digits are taken as written, the same convention as the metadata drone_id.
 */
function droneHint(stem: string): number | null {
  const m = stem.match(/(?:drone|uav|agent)[ _-]?([a-f]|\d{1,2})(?![a-z0-9])/);
  if (!m) return null;
  return /\d/.test(m[1]) ? Number(m[1]) : m[1].charCodeAt(0) - 97;
}

/**
 * First non-numeric cell of a standard column, by file line. parseTrajectoryCsv only checks t, and
 * a stray NaN in x would be smeared over the whole file by the smoothing of position-only files.
 */
function badCell(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n].trim();
    if (!l || l.startsWith('#')) continue;
    const cells = l.split(/[,;\t]/).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    for (let j = 0; j < header.length; j++) {
      const col = header[j];
      if (!(CSV_COLUMNS as readonly string[]).includes(col)) continue;
      const cell = cells[j] ?? '';
      if (cell === '' ? ['t', 'x', 'y', 'z'].includes(col) : Number.isNaN(Number(cell))) return `line ${n + 1}: "${col}" is ${cell === '' ? 'empty' : `not a number ("${cell.slice(0, 20)}")`}.`;
    }
  }
  return null;
}

/** First non-finite sample of any channel (the validator's bounds check cannot see NaN). */
function nonFinite(tr: Trajectory): string | null {
  for (const c of CSV_COLUMNS) {
    const a = tr[c];
    for (let k = 0; k < a.length; k++) {
      if (!Number.isFinite(a[k])) return `missing or non-numeric "${c}" value near t = ${(Number.isFinite(tr.t[k]) ? tr.t[k] : 0).toFixed(2)} s.`;
    }
  }
  return null;
}

/**
 * Pair metadata with CSVs and parse them. Pure apart from parsing, so it can be tested and reused
 * by the drop zone and the file picker alike.
 */
export function buildImport(files: TextFile[]): ImportOutcome {
  const errors: string[] = [];
  const warnings = new Map<string, string[]>();
  const warn = (msg: string, file = '') => warnings.set(msg, [...(warnings.get(msg) ?? []), ...(file ? [file] : [])]);

  const metas: MetaEntry[] = [];
  const csvs: CsvEntry[] = [];
  for (const f of files) {
    if (/\.json$/i.test(f.name)) {
      try {
        const meta = parseMetaJson(f.text);
        // a JSON with none of the standard keys is something else (a config, a trial log): say so
        if (Object.keys(meta).length) metas.push({ name: f.name, stem: metaStem(f.name), meta, used: false });
        else warn('Not trajectory metadata (no run_id, drone_id, solver, … keys); ignored.', f.name);
      } catch (e) {
        errors.push(`${f.name}: not valid metadata JSON (${errText(e)}).`);
      }
    } else {
      const stem = csvStem(f.name);
      csvs.push({ ...f, stem, hint: droneHint(stem), meta: null });
    }
  }

  // pairing, most specific rule first so a weaker rule cannot steal a file-name match
  const take = (m: MetaEntry | undefined, c: CsvEntry) => {
    if (!m) return;
    m.used = true;
    c.meta = m.meta;
  };
  for (const c of csvs) take(metas.find((m) => !m.used && m.stem === c.stem), c);
  for (const c of csvs) if (!c.meta && c.hint !== null) take(metas.find((m) => !m.used && m.meta.drone_id === c.hint), c);
  const free = () => metas.filter((m) => !m.used);
  const unpaired = () => csvs.filter((c) => !c.meta);
  if (free().length === 1 && unpaired().length === 1) take(free()[0], unpaired()[0]);
  // one leftover file without a drone_id reads as run-wide metadata (run_id, solver, track, …)
  let shared: Partial<TrajectoryMeta> = {};
  const left = free();
  if (left.length === 1 && left[0].meta.drone_id === undefined && unpaired().length) {
    shared = left[0].meta;
    left[0].used = true;
    warn(`Applied ${left[0].name} as run-wide metadata to the CSVs without their own.`);
  }
  for (const m of free()) warn('No matching CSV (pair by file name or drone_id); metadata ignored.', m.name);

  const id = (c: CsvEntry) => c.meta?.drone_id ?? c.hint ?? Infinity;
  csvs.sort((a, b) => (id(a) === id(b) ? a.name.localeCompare(b.name, undefined, { numeric: true }) : id(a) < id(b) ? -1 : 1));

  const trajectories: Trajectory[] = [];
  const sources: string[] = [];
  const explicitId: boolean[] = [];
  for (const c of csvs) {
    const did = c.meta?.drone_id ?? c.hint ?? undefined;
    try {
      const cellError = badCell(c.text);
      if (cellError) throw new Error(cellError);
      const r = parseTrajectoryCsv(c.text, { run_id: baseName(c.name), ...shared, ...(c.meta ?? {}), ...(did !== undefined ? { drone_id: did } : {}) });
      const bad = nonFinite(r.trajectory);
      if (bad) throw new Error(bad);
      r.warnings.forEach((w) => warn(w, c.name));
      trajectories.push(r.trajectory);
      sources.push(c.name);
      explicitId.push(did !== undefined);
    } catch (e) {
      errors.push(`${c.name}: ${errText(e)}`);
    }
  }
  if (trajectories.length > MAX_DRONES) {
    warn(`Only the first ${MAX_DRONES} of ${trajectories.length} trajectories were imported (drone_id order): the arena flies at most ${MAX_DRONES} drones.`);
    trajectories.length = MAX_DRONES;
    sources.length = MAX_DRONES;
  }
  // without an id from metadata or the file name, the slot order is the drone id
  trajectories.forEach((tr, i) => {
    if (!explicitId[i]) tr.meta.drone_id = i;
  });
  return { trajectories, sources, errors, warnings };
}

/** Read dropped / picked files, import the trajectories and switch the scenario to "imported". */
export async function importTrajectoryFiles(files: File[]): Promise<void> {
  const { toast } = useStore.getState();
  const wanted = files.filter((f) => /\.(csv|json)$/i.test(f.name));
  const skipped = files.length - wanted.length;
  if (!wanted.some((f) => /\.csv$/i.test(f.name))) {
    toast(wanted.length ? 'Only metadata JSON was given: add the trajectory CSV files (one per drone).' : 'No .csv or .json files: drop the trajectory CSVs from the lab’s solvers.', 'warning');
    return;
  }
  let loaded: TextFile[];
  try {
    loaded = await Promise.all(wanted.map(async (f) => ({ name: f.name, text: await f.text() })));
  } catch (e) {
    toast(`Could not read the files: ${errText(e)}`, 'error');
    return;
  }
  const out = buildImport(loaded);
  if (skipped) out.warnings.set(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? 'are' : 'is'} not .csv or .json.`, []);

  // the toast stack keeps four: beyond two failures, one combined toast keeps the summary visible
  if (out.errors.length <= 2) out.errors.forEach((e) => toast(e, 'error'));
  else toast(`${out.errors.length} files could not be imported: ${out.errors.join(' · ')}`, 'error');
  out.warnings.forEach((fs, msg) => toast(fs.length ? `${fs.join(', ')}: ${msg}` : msg, 'warning'));

  const trajs = out.trajectories;
  if (!trajs.length) {
    toast('No trajectory could be imported; the current scenario is unchanged.', 'error');
    return;
  }
  setImportedTrajectories(trajs);
  useStore.getState().setConfig((c) => {
    c.scenario.type = 'imported';
    c.scenario.preset = '';
    c.scenario.timeScale = 1;
    // keep each drone's preset and colour, but drop manual starts: the files define where they start
    c.drones = trajs.map((_, i) => (c.drones[i] ? { ...c.drones[i], start: null } : { preset: 'CF21', color: DRONE_COLORS[i], start: null }));
  });
  const parts = trajs.map((tr, i) => `${DRONE_NAMES[i]} ${out.sources[i]} (${(tr.t[tr.t.length - 1] ?? 0).toFixed(1)} s)`);
  toast(`Imported ${trajs.length} ${trajs.length === 1 ? 'trajectory' : 'trajectories'}: ${parts.join(' · ')}. The validator checks them before flight.`, 'success');
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Window-wide drop zone with a full-screen hint while files are dragged over the app. */
export function FileDrop() {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every element crossed; count them instead of trusting relatedTarget
  const depth = useRef(0);

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // without preventDefault the browser refuses the drop and opens the file instead
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
      if (depth.current === 0 || outside) reset();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      reset();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void importTrajectoryFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dragging) return null;
  // the backdrop takes the pointer so enter/leave only toggle between it and the outside
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-6 backdrop-blur-sm">
      <div className="pointer-events-none max-w-lg rounded-xl border-2 border-dashed border-sky-400 bg-white/90 px-8 py-6 text-center shadow-2xl dark:bg-slate-900/90">
        <svg viewBox="0 0 24 24" className="mx-auto mb-2 h-9 w-9 text-sky-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 15V4m0 0-4 4m4-4 4 4" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Drop the lab’s trajectory CSV files (one per drone) and optional metadata JSON</div>
        <div className="mt-2 text-[11px] leading-snug text-slate-600 dark:text-slate-400">
          Columns <span className="font-mono">{CSV_COLUMNS.join(',')}</span>, or just <span className="font-mono">t,x,y,z</span> (velocity and acceleration are then derived). Up to {MAX_DRONES} drones; the
          validator checks the files before they fly.
        </div>
      </div>
    </div>
  );
}

/** "Import CSV…" button: the same import through a file picker. */
export function ImportButton({ small, className }: { small?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // clear so picking the same files again still fires a change
    e.target.value = '';
    if (files.length) void importTrajectoryFiles(files);
  };
  return (
    <>
      <input ref={input} type="file" multiple accept=".csv,.json" className="hidden" onChange={onChange} />
      <Button
        small={small}
        className={className}
        title="Load trajectory CSVs from the lab’s solvers (one per drone) plus optional metadata JSON. You can also drop them anywhere on the window."
        onClick={() => input.current?.click()}
      >
        Import CSV…
      </Button>
    </>
  );
}
