/** The guided modes, in TopBar order. The card component is generic; all content is here. */
import { M1_GUIDE } from './m1';
import { M2_GUIDE } from './m2';
import { M3_GUIDE } from './m3';
import { SCORECARD_GUIDE } from './ScorecardExplainer';
import type { GuideDef, GuidedMode } from './types';

export const GUIDES: Record<GuidedMode, GuideDef> = { m1: M1_GUIDE, m2: M2_GUIDE, m3: M3_GUIDE, scorecard: SCORECARD_GUIDE };

/** The mode the last step's "Next" leads to. */
export const NEXT_MODE: Record<GuidedMode, GuidedMode | null> = { m1: 'm2', m2: 'm3', m3: 'scorecard', scorecard: null };
