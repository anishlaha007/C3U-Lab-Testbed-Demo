# Progress

Checklist of the build phases (Section 14 of the build prompt).

- [x] Phase 1: scaffold and scene (Vite/React/TS/Tailwind, arena, Vicon cameras, kinematic T1 figure-8 with trail, orbit camera)
- [x] Phase 2: core physics (scheduler, dynamics, onboard controllers, sensing, executor, M1-M9, Live/Tracking panels, feasibility colouring)
- [x] Phase 3: multi-drone safety (CBF filters, obstacle constraints, QP, latency compensation, reference consistency, supervisor, collisions, M10-M17; M15 solo runs land with the sweep worker in phase 6)
- [x] Phase 4: scenarios and files (trajectory library, presets T1-T14, gates, obstacles, courses C1-C12, racing line with A* detours, validator, CSV core, URL hash) — course editor and CSV drop/export UI in review
- [x] Phase 5: planners (track, candidates, rollouts, Independent/Nash/Stackelberg, N-drone IBR / priority chain, receding-horizon re-planning, worker, payoff matrix, Race and Game tabs, M18-M22)
- [ ] Phase 6: scorecard, milestones and statistics
- [ ] Phase 7: polish and ship
