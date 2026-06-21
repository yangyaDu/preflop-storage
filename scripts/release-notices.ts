console.warn(
  [
    "[release notice] Scheme1 (src/scheme1, range-db/binary) is deprecated as of 2026-06-21.",
    "[release notice] Use Range Strata Binary (src/range-strata-binary, range-db/range-strata-binary) for new build/query/verify/benchmark work.",
    "[release notice] Scheme1 is retained for legacy compatibility and SQLite baseline comparison through 0.2.x; target removal is 0.3.0.",
  ].join("\n"),
);
