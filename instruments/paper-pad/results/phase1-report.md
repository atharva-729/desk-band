# Paper Pad · Phase 1 signal test

Generated 2026-11-19 09:08 by `node tools/phase1.js`. Every number is from **training on one recorded session and testing on a different one** (both directions, counts summed). No split of a single session is used.

## Sessions

| session | setup | length | seconds | taps heard (exactly once) | flicks heard (exactly once) | sharp sounds per second: scratch / rub / quiet |
|---|---|---|---|---|---|---|
| notebook-full-20261119-090336 | notebook | full | 124.97 | 10 of 10 (9) | 10 of 10 (8) | 1.3 / 0.6 / 0.0 |
| notebook-short-20261119-090634 | notebook | short | 62.97 | 5 of 5 (2) | 5 of 5 (4) | 1.5 / 0.5 / 0.0 |

## Main result: Phone on an open notebook

Balanced accuracy = the average of the five per-class hit rates, so 10 taps count as much as hundreds of scratch windows. Chance is 20%.

| window | features | balanced accuracy | tap | flick | scratch | rub | quiet | sharp sounds during scratch/rub named right |
|---|---|---|---|---|---|---|---|---|
| 150 ms | mic | **80%** | 93% | 60% | 71% | 90% | 87% | 77% |
| 150 ms | mic + accel | **89%** | 100% | 80% | 84% | 92% | 90% | 91% |
| 150 ms | mic + texture | **90%** | 100% | 80% | 88% | 92% | 90% | 89% |
| 150 ms | mic + accel + texture | **92%** | 100% | 87% | 89% | 93% | 94% | 94% |
| 50 ms | mic | **77%** | 87% | 53% | 72% | 85% | 87% | 69% |
| 50 ms | mic + accel | **82%** | 73% | 80% | 79% | 88% | 89% | 83% |
| 50 ms | mic + texture | **87%** | 93% | 87% | 83% | 85% | 87% | 77% |
| 50 ms | mic + accel + texture | **88%** | 87% | 87% | 85% | 89% | 93% | 89% |

### Confusion matrix: 150 ms, mic + accel + texture

Rows: what the prompt asked for. Columns: what the model said.

| asked \ heard | tap | flick | scratch | rub | quiet | right |
|---|---|---|---|---|---|---|
| **tap** | **15** | · | · | · | · | 100% |
| **flick** | 1 | **13** | · | 1 | · | 87% |
| **scratch** | 7 | 3 | **299** | 1 | 27 | 89% |
| **rub** | · | 3 | 3 | **300** | 16 | 93% |
| **quiet** | · | · | 8 | 11 | **293** | 94% |

## How much training it needs

Trained on the first part of one session (in the order it was recorded), tested on the whole other session.

| part of session | tap examples | flick examples | scratch windows | balanced accuracy |
|---|---|---|---|---|
| 25% | 3 | 1 | 58 | 73% |
| 50% | 6 | 4 | 58 | 89% |
| 75% | 9 | 6 | 170 | 86% |
| 100% | 10 | 10 | 224 | 92% |

## Setups

| setup | sessions | balanced accuracy (session to session) |
|---|---|---|
| Phone on an open notebook | 2 | 92% |

## Go / no-go

Best: **92%** balanced accuracy (150 ms windows, mic + accel + texture). Threshold 85%: **GO**.

Caveat: the best of 8 combinations is picked on the test sessions, which flatters it slightly. The live Check accuracy round (Phase 3) is the real number.
