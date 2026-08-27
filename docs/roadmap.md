# Roadmap

The roadmap is driven by public issues and measurable acceptance criteria.

## P0 — reliability and release

- publish independently installable packages and verify a clean consumer install;
- add retry/backoff and a public node-error policy;
- test real remote decode and multi-page hierarchy traversal;
- protect `main` with required CI and pull-request review.

## P1 — performance and diagnostics

- move runtime color, opacity, and filters to GPU paths;
- report fetch, decode, build, and actual transfer latency distributions;
- expose CRS resolution and fallback diagnostics;
- automate browser camera paths and meaningful-view metrics;
- benchmark 1–2 GiB sources and long-duration memory behavior.

## P2 — ecosystem

- harden WKT1/WKT2 parsing and add more vertical reference models;
- document bundler recipes and Worker/WASM packaging;
- expand styling expressions and analysis operations;
- collect external compatibility reports and contribution examples.

Progress is tracked in
[GitHub Issues](https://github.com/yangseungsang/cesiumjs-copc-runtime/issues) and
release milestones. Priorities may change when reproducible defects or security
concerns are discovered.
