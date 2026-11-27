# Frost Squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/AryFlows/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/AryFlows/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG compressor for 1280x720 screenshots, built for make.fun's
[Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

`main.ts` (Node 22, no dependencies) reads `/input/i001..i008/image.png` and
writes `/output/<id>/image.png` for the whole set in one run:

- Colour-type reduction per instance: palette (three orderings), grey,
  grey+alpha, RGB, RGBA, with a tRNS key when one transparent colour can
  carry the alpha channel.
- Per-row PNG filter search: fixed filter 0, minimum-sum and
  fewest-distinct-pairs heuristics, plus brute force by real deflate cost
  against the preceding 32 KiB.
- Final encoding is the smallest of zlib level 9, a hand-written lazy LZ77 +
  dynamic-Huffman deflate, and an optimal-parse (shortest-path) deflate.
- Fully deterministic: no clock, environment, or randomness.

Practice set score: **721,269** (house baseline fixed-paeth 1.0.0: 420,399).
