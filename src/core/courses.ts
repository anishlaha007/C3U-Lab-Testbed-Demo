/** Course library metadata (layouts are built in courseLibrary.ts). */
import type { CourseId } from './types';

export interface CourseInfo {
  id: CourseId;
  name: string;
  difficulty: number;
  layout: string;
  hard: string;
}

export const COURSE_INFO: CourseInfo[] = [
  { id: 'C1', name: 'Slalom', difficulty: 2, layout: '6 gates in a zig-zag line, alternating 1 m left/right, heights alternating 0.8 / 1.4 m', hard: 'Constant direction and height changes' },
  { id: 'C2', name: 'Hairpin', difficulty: 3, layout: 'Two gates 1.2 m apart facing opposite directions, then a third gate back the way you came', hard: '180° turns at speed' },
  { id: 'C3', name: 'Corkscrew', difficulty: 4, layout: '6 gates on a rising helix (radius 1.5 m, climbing 1.2 m), each rotated 60° from the last', hard: 'Combined climb and turn, thrust limits' },
  { id: 'C4', name: 'Ladder dive', difficulty: 4, layout: 'Hanging gates stacked vertically (0.6 / 1.2 / 1.8 m) entered in alternating directions, a split-S', hard: 'Vertical manoeuvres, downwash when two drones stack' },
  { id: 'C5', name: 'Keyhole', difficulty: 4, layout: 'A small gate (0.45 m) directly behind a pillar', hard: 'Precision plus obstacle avoidance' },
  { id: 'C6', name: 'Forest', difficulty: 4, layout: '5 gates spread through a field of 8 to 12 seeded pillars', hard: 'Path planning through clutter; obstacle filter interventions' },
  { id: 'C7', name: 'Gauntlet', difficulty: 5, layout: '4 gates with a swinging pendulum and a sliding panel between them', hard: 'Dynamic obstacles; timing; reactive safety' },
  { id: 'C8', name: 'Merge', difficulty: 3, layout: 'Two side-by-side gates feeding a single small gate (the pinch ring)', hard: 'Who goes first; Nash vs Stackelberg' },
  { id: 'C9', name: 'Figure-8 circuit', difficulty: 3, layout: '5 gates on a 5 m x 5 m figure-8, one gate passed twice per lap (after Pasumarti et al. 2025)', hard: 'Comparable to published results' },
  { id: 'C10', name: 'Complex circuit', difficulty: 5, layout: '6 gates including a split-S pair plus 4 pillars on an 8 m x 7 m course', hard: 'Everything at once' },
  { id: 'C11', name: 'Random course', difficulty: 3, layout: 'Seeded generator with a difficulty slider', hard: 'Endless new tests; validated flyable at the chosen speed' },
  { id: 'C12', name: 'Custom', difficulty: 3, layout: 'The course editor', hard: 'The lab’s real layout' },
];
