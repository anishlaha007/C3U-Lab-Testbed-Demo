/**
 * Data-driven narration (Section 12): a guided mode is a list of short steps. Each step has a
 * title, an optional `enter` action that configures the scene once when the step is entered (never
 * on re-render, so the user can change things afterwards without the card fighting back) and a
 * body component with the explanation, live numbers and explicit action buttons.
 */
import type { ComponentType } from 'react';
import type { Mode } from '../store';

export type GuidedMode = Exclude<Mode, 'sandbox'>;

export interface StepDef {
  /** Short title shown under the step dots. */
  title: string;
  /** Configure the scene when the step is entered (preset, visuals, camera, right tab, fly). */
  enter?: () => void;
  Body: ComponentType;
}

export interface GuideDef {
  mode: GuidedMode;
  /** Tab label, e.g. "Milestone 1". */
  label: string;
  /** What the milestone demonstrates. */
  title: string;
  steps: StepDef[];
}
