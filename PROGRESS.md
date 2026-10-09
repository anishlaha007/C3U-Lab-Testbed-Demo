# Progress

Checklist of the build phases (Section 14 of the build prompt).

- [x] Phase 1: scaffold and scene (Vite/React/TS/Tailwind, arena, Vicon cameras, kinematic T1 figure-8 with trail, orbit camera)
- [x] Phase 2: core physics (scheduler, dynamics, onboard controllers, sensing, executor, M1-M9, Live/Tracking panels, feasibility colouring)
- [x] Phase 3: multi-drone safety (CBF filters, obstacle constraints, QP, latency compensation, reference consistency, supervisor, collisions, M10-M17)
- [x] Phase 4: scenarios and files (trajectory library, presets T1-T14, gates, obstacles, courses C1-C12, racing line with A* detours, validator, course editor with worker-side validation and floor-plan export, CSV import (drag and drop) and export menu, URL hash)
- [x] Phase 5: planners (track, candidates, rollouts, Independent/Nash/Stackelberg, N-drone IBR / priority chain, receding-horizon re-planning, worker, payoff matrix, Race and Game tabs, M18-M22)
- [ ] Phase 6: scorecard, milestones and statistics
  - [x] experiment engine (M1 speed sweep and comparisons, M2 safety / margin / scaling sweeps, M3 race series) with bootstrap CIs, Wilson, binomial, permutation tests, Holm, ranking stability
  - [x] sweep worker pool with progress and cancel; M15 cost of safety for recorded trials
  - [ ] Results tab
  - [ ] guided milestone narration (M1, M2, M3) and Scorecard mode
- [ ] Phase 7: polish and ship
  - [x] README (controls, presets, mapping onto the ROS 2 testbed, deploy), docs/MODEL.md, DECISIONS.md
  - [x] vendor chunk splitting, one-row responsive top bar, FPV fisheye lens, trail speed legend, chart fixes
  - [x] CI (test + build) and a manual GitHub Pages deploy workflow
  - [ ] screenshots in docs/screenshots
  - [ ] final end-to-end pass of every preset and guided mode
