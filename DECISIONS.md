# Decisions

Non-obvious choices made while building the simulator, with the reason for each.

## Stack

- **React 18** (as the prompt specifies) with the matching three.js bindings: `@react-three/fiber` 8 and
  `@react-three/drei` 9 (fiber 9 / drei 10 require React 19). three.js is pinned to r172, the last release
  these bindings were validated against.
- **Vite 7** + **Vitest 3** + **Tailwind CSS 4** (via `@tailwindcss/vite`). TypeScript 5.9 strict.
- `base: './'` in `vite.config.ts` so the static build works from any sub-path (GitHub Pages, Vercel, a file server).

## Scene

- Net walls are single-sided planes whose front face points into the arena, so walls between an outside
  camera and the arena are culled and do not veil the view.
