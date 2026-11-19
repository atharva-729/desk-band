# Paper Pad

**A sheet of paper becomes an instrument. The phone listens to *how* you touch it.**

Lay the phone flat on the table with a sheet of paper or an open notebook next to it, or slipped under it. Each way of touching paper sounds different, and the phone's microphone can tell them apart:

| Touch | What you do | Plays |
|---|---|---|
| **Tap** | fingertip knock on the paper | kick drum |
| **Flick** | fingernail flick on the paper | snare / clap |
| **Scratch** | drag a fingernail across the paper | DJ scratch (faster scratch = higher pitch) |
| **Rub** | palm or fingertips rubbed back and forth | shaker (harder rub = louder) |

A small model, the same kind Desk Band uses, learns these from about 10 prompted examples of each. It recognises **how** you touch, not **where**: loose paper moves, so locating a tap on it is unreliable, but the kind of touch stays the same.

Instrument #2 in the phone-instrument set (Desk Band is #1). It lives in its **own folder** (`instruments/paper-pad/`) on `main`, fully separate from Desk Band and the other instruments. Other Claude Code sessions are working in the same repo at the same time, each in its own folder.

**Prior art, to cite rather than repeat:** *Scratch Input* (Harrison & Hudson, UIST 2008) recognised fingernail gestures on walls and tables with a separate stethoscope-style sensor, about 90% accuracy on six gestures. A Cornell ECE 4760 project (2009) repeated it with a microcontroller. **Our angle:** the phone's own microphone, paper as the surface, an instrument rather than commands, in a plain web page.

---

## Run it

```
cd instruments/paper-pad
python server.py              # laptop http://localhost:8001, phone https://<ip>:8444 (QR on the laptop page)
node tests/test_core.js       # offline core test (synthetic knocks)
node tests/plumbing_e2e.js [out-dir]   # fake-mic phone + laptop in headless Chrome/Edge; starts its own server on 8101/8544
node tests/recorder_e2e.js [out-dir]   # fake-mic phone records two short sessions; checks what the laptop saved
node tests/test_phase1.js     # the Phase 1 analysis on synthetic sessions (pipeline check only, not real accuracy)
node tools/phase1.js          # Phase 1 analysis on your recordings in data/sessions/ -> results/phase1-report.md
```

**Status:**
- Phase 0 (skeleton) done. The phone page starts the mic and motion sensors, forwards every sharp sound it hears, and has a "Send test hit" button and a 1-minute prompted self-test. The stage page shows the QR join card, whether the phone is connected (heartbeat every 2 s), and each event, with a short synthesised knock. The laptop logs every event to `data/events-<date>.jsonl`.
  - Live self-test (iPhone, paper next to the phone): taps heard exactly once 6 of 6, flicks 6 of 6, 47–61 ms phone listening delay. Scratch and rub trigger only 0–3 onsets in 3 s, so they need their own window-based path, as planned.
- Phase 1 result (2 sessions, phone lying on an open notebook, 1 full + 1 short, trained on one and tested on the other): **92% balanced accuracy, GO** (150 ms windows, mic + accel + texture). Tap 100%, flick 87%, scratch 89%, rub 93%, quiet 94%. Mic alone: 80%. The main error is scratch heard as quiet, in the gaps between strokes. Accuracy levels off after about 5–6 taps and flicks. Full report: `results/phase1-report.md`. The other two setups weren't recorded; Atharva plays with the phone on paper.
  - **Recorder** (phone page, "Record a session"): prompts in random order, full = 10 tap, 10 flick, 4 × 3 s scratch, 4 × 3 s rub, 4 × 3 s keep still (~2 min); short = half. Raw mic audio streams to `data/sessions/<id>/audio.pcm16` (local only) with `meta.json` holding the prompt times and motion readings, all as sample numbers on the audio's own clock. The laptop stays silent while recording.
  - **Recording plan:** 2 full sessions with the paper next to the phone, 2 short with the phone on an open notebook, 2 short with the phone on a loose A4 sheet. The phone ticks them off.
  - **Examples** (`tools/phase1.js`): taps and flicks = the window at the strongest onset during the prompt; scratch, rub and quiet = a window every 50 ms from 300 ms after "now", plus every onset inside those prompts (what the hit path would see). Windows of 150 ms and 50 ms.
  - **Feature sets:** mic (Desk Band band energies), mic + accel, mic + texture (centroid, flatness, roll-off, ZCR, loudness shape, 500 ms rhythm), all three.
  - **Scoring:** train on one session, test on another, both ways. Balanced accuracy (average of the 5 per-class hit rates), confusion matrix, learning curve, setup comparison and setup transfer.

---

## Ground rules (read first)

**Do**
- Work **only inside `instruments/paper-pad/`**.
- Commit **only your own folder**: `git add instruments/paper-pad/`, then `git commit -m "paper-pad: …" -- instruments/paper-pad/`. The `-- <folder>` at the end keeps other sessions' files out of your commit. If git says `index.lock` exists, another session is committing: wait a few seconds and retry. Never delete the lock file.
- When you need shared code (`server.py`, `static/core.js`, the QR library), **copy** it into this folder and change the copy.
- Use the ports for this instrument: **HTTPS 8444** (phone) and **HTTP 8001** (laptop stage). Desk Band uses 8443/8000, so both can run at once.
- Add `instruments/paper-pad/.gitignore` containing `data/`, `.certs/`, `*.wav`, `*.m4a`, `*.webm`, `__pycache__/`. The root `.gitignore` rule `data/training/` only applies at the repo root, so it doesn't cover this folder.
- Keep the stack the same as Desk Band: a Python stdlib server, plain HTML and JS, no build step, no frameworks, Node for tests.
- Keep the iOS rules: HTTPS, ask for permission inside a tap handler, and `echoCancellation`, `noiseSuppression` and `autoGainControl` all set to **false**.
- Take labels **only from prompts**. Atharva never labels anything by hand.
- Stop at every **CHECKPOINT**, show what it lists, and wait for a go-ahead.

**Don't**
- Don't edit, move or reformat anything outside this folder. That includes the root `server.py`, `static/`, `tests/`, `README.md`, `HANDOFF.txt`, `CLAUDE.md` and `.gitignore`.
- Never run `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout` / `git switch`, `git reset`, `git restore` or `git pull`. These touch other sessions' work. Don't push; Atharva pushes.
- Don't commit raw audio. Feature files and JSON reports go in `instruments/paper-pad/results/`.
- Don't quote an accuracy number unless it comes from a **separately recorded, prompted** session. Same-session cross-validation is optimistic.
- Don't use downloaded or copyrighted sound samples. Synthesise every sound with WebAudio.

---

## How it works (the plan)

```
phone mic ──► frames (~23 ms) ──► features ──► classifier ──► touch type + intensity ──► laptop plays sound
                 │                                                ▲
                 └─► onset detector (taps, flicks: fast path) ────┘
```

- **Two kinds of touch.**
  - *Hits* (tap, flick) are single sharp events. Use Desk Band's onset detector and classify the short segment around the peak. They must feel instant: aim for about 60 ms, like Desk Band.
  - *Textures* (scratch, rub) last a while. Classify sliding windows of about 150 ms, every 50 ms. Up to about 100 ms of delay is acceptable for these.
  - There is also a **quiet** class, collected automatically ("keep still for 3 seconds").
- **Features to try.**
  - log band energies, as in Desk Band;
  - spectral centroid, flatness and roll-off;
  - zero-crossing rate;
  - envelope modulation (rubbing has a back-and-forth rhythm; scratching is a steady hiss);
  - the accelerometer jolt for hits, as in Desk Band.
- **Continuous control.**
  - Scratch: energy and centroid set the scratch speed, which drives the playback rate and pitch of the synthesised scratch.
  - Rub: energy sets the shaker volume.

---

## Phase 0: Skeleton

1. Create `instruments/paper-pad/` containing:
   - `server.py`, copied from the root and changed to ports 8444/8001, with certificates in `instruments/paper-pad/.certs/`;
   - `static/phone.html` and `static/stage.html`;
   - a copy of `core.js`;
   - a `tests/` folder;
   - the `.gitignore` described above.
2. Prove the plumbing: the phone joins by QR code, the mic and motion permissions work, and a test "hit" from the phone shows up on the stage page.
3. Commit.

### CHECKPOINT 0
- The commands to run it.
- A screenshot of the stage page with the phone connected.
- `git status` showing only files under `instruments/paper-pad/` changed.

---

## Phase 1: Signal test (go / no-go)

The question: **can one phone mic reliably tell tap, flick, scratch, rub and quiet apart?**

1. Build a **guided recorder** on the phone page:
   - random order;
   - prompts such as "Tap ×10", "Scratch for 3 s", "Rub for 3 s", "Flick ×10", "Keep still 3 s";
   - each label comes from the prompt that was showing.
   - Save the features and labels to the laptop under `data/sessions/`. Raw audio may be saved there locally, but never committed.
2. Atharva records **two separate passes** in different orders.
3. Offline (Python or Node), train on pass 1 and test on pass 2, then the reverse. Report a **confusion matrix**. Compare three feature sets: mic only, mic plus accelerometer, and mic with the extra texture features.
4. Try three setups, one short pass each:
   - paper next to the phone;
   - the phone lying on an open notebook;
   - a single loose A4 sheet.
   Report which works best.

**Go / no-go:** at least **85%** accuracy across passes on the 4 touch types plus quiet. If it fails, report which pairs get confused and suggest either merging those classes or a different set of touches. Don't build Phase 2 on a no-go.

### CHECKPOINT 1
- Confusion matrices for the three feature sets.
- The setup comparison.
- A go/no-go recommendation.
- How many training examples per class it needs before accuracy levels off.

---

## Phase 2: Live instrument

1. Run the classifier live on the phone:
   - training uses the same guided flow as Phase 1;
   - training is saved on the laptop, like Desk Band;
   - "fix it while you play": tap the right touch type on screen after a wrong guess and it learns from that example.
2. Stage page sounds, all synthesised:
   - kick for tap;
   - snare or clap for flick;
   - a DJ-style scratch for scratch, with pitch and rate following scratch speed;
   - a looping shaker for rub, with volume following rub energy and a fade-out when the rub stops.
3. Explainer panel on the stage, matching Desk Band's style:
   - a live scrolling spectrogram;
   - the current touch type with confidence bars;
   - an intensity meter;
   - an 8-second timeline of recognised touches, colour-coded.
4. Measure latency: time from the start of the touch to the sound, for hits and for textures. Use the same "phone hears both" method planned for Desk Band if possible; otherwise report the phone's processing delay.

### CHECKPOINT 2
- A 30-second screen recording of Atharva playing: taps and flicks as a beat, scratches and rubs over it.
- The measured latency for hits and for textures.
- Any touch type that misfires when played live (as opposed to the offline test).

---

## Phase 3: Demo polish

1. A **Check accuracy** round: 5 prompted touches of each type, random order, giving an honest "X of Y right" on screen.
2. The **● Record demo** button, copied from Desk Band: screen plus audio as a .webm file.
3. A QR join card, a "Hide explainer" toggle, and a camera card, all copied from Desk Band.
4. Update this README with:
   - how to run it;
   - the results tables (only measured numbers);
   - prior art;
   - limits.

### CHECKPOINT 3
- A screenshot.
- The Check accuracy result.
- A 20-second recorded demo.
- 4–5 talking points for the demo.

---

## Out of scope
- Where on the paper you touched (location).
- Handwriting or drawing recognition.
- More than one phone.
- Any AI/LLM.
- Changes to Desk Band.

## Rough timeline
| Phase | Time |
|---|---|
| 0 Skeleton | 30 min |
| 1 Signal test | 1–2 hours, including about 10 min of Atharva recording |
| 2 Live instrument | 2–3 hours |
| 3 Polish | 1 hour |