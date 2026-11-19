# Paper Pad · Phase 2 live-pipeline replay

Generated 2026-11-19 11:35 by `node tools/simulate.js`. Trained on one recording, then a **different** recording is replayed through the phone's live engine (`static/engine.js`) and what it would have played is scored against the prompts.

- **tap / flick**: the prompt got exactly the right sound first (extra sounds counted separately).
- **scratch / rub**: share of 50 ms frames, from 300 ms after "now", where that sound was playing.
- **quiet**: share of the time nothing was playing.
- **hit delay**: from the touch's peak to the decision on the phone (network and laptop audio come on top).
- **texture delay**: from the first loud 10 ms of the scratch or rub to the sound switching on, on the phone.

- **false texture**: share of the time during tap, flick and keep-still prompts (including just after each tap) that a scratch or rub sound was playing.

| setting | balanced | tap | flick | scratch | rub | quiet | false texture | extra hit sounds | false hits in scratch/rub | false hits in quiet | hit delay | texture delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default: hit 75 ms; texture on after 1 frame if 80% sure (else 2); loudness gate; trained on the quiet around taps | **91%** | 100% | 87% | 82% | 86% | 100% | 4% | 1 | 4 | 0 | 73 ms | 119 ms |
| texture on after 1 frame if 70% sure | **91%** | 100% | 87% | 83% | 86% | 100% | 5% | 1 | 4 | 0 | 73 ms | 113 ms |
| texture on after 1 frame if 60% sure | **91%** | 100% | 87% | 84% | 87% | 100% | 6% | 1 | 4 | 0 | 73 ms | 93 ms |
| no loudness gate | **90%** | 100% | 87% | 82% | 86% | 95% | 11% | 1 | 4 | 0 | 73 ms | 119 ms |
| louder gate (+0.6) | **91%** | 100% | 87% | 82% | 85% | 100% | 3% | 1 | 4 | 0 | 73 ms | 119 ms |
| not trained around taps | **91%** | 100% | 87% | 85% | 86% | 100% | 7% | 1 | 4 | 0 | 73 ms | 42 ms |
| trained around taps, touch windows too | **92%** | 100% | 93% | 80% | 86% | 100% | 2% | 2 | 5 | 0 | 73 ms | 191 ms |
| texture waits for the hit decision, then 250 ms hold | **90%** | 100% | 87% | 78% | 85% | 100% | 3% | 1 | 4 | 0 | 73 ms | 202 ms |
| neither gate nor around-tap training (the first Phase 2 build) | **90%** | 100% | 87% | 86% | 86% | 93% | 26% | 1 | 4 | 0 | 73 ms | 42 ms |
| hit 50 ms (faster) | **88%** | 87% | 87% | 82% | 86% | 100% | 4% | 1 | 8 | 0 | 54 ms | 119 ms |
| hit 100 ms (slower) | **90%** | 100% | 80% | 82% | 86% | 100% | 4% | 1 | 1 | 0 | 98 ms | 119 ms |
| texture off after 1 frame | **91%** | 100% | 87% | 80% | 86% | 100% | 3% | 1 | 4 | 0 | 73 ms | 119 ms |
| texture off after 3 frames | **91%** | 100% | 87% | 83% | 86% | 100% | 6% | 1 | 4 | 0 | 73 ms | 119 ms |
| no echo filter | **91%** | 100% | 87% | 82% | 86% | 100% | 4% | 1 | 4 | 0 | 73 ms | 119 ms |
| plus motion features (phone motion on) | **91%** | 100% | 87% | 83% | 86% | 100% | 5% | 1 | 5 | 0 | 72 ms | 135 ms |
| plus motion features, but no motion readings live | **74%** | 100% | 47% | 35% | 87% | 100% | 2% | 1 | 4 | 0 | 72 ms | 185 ms |

Default setting in detail: taps 15 right / 0 wrong sound / 0 missed of 15; flicks 13 / 1 / 1 of 15. Scratch frames playing rub instead: 0; rub frames playing scratch: 0.
