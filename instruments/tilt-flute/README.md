# Tilt Flute

**Tilt the phone to pick a note, blow on it to play.**

Hold the phone up in one hand.
- **Tilt it forward or back** to choose the note. The tilt range is split into 8 steps, and each step is one note of the **full major scale** (C up to high C), so real tunes like Twinkle Twinkle work. A **pentatonic** mode, which is hard to sound bad in, is an option.
- **Blow on the microphone** to sound the note. Blow harder for louder; stop blowing and the note stops.
- **Roll it left or right** to add vibrato (wobble), or bend the note slightly.

The phone screen shows the current note in large letters, so you can see where you are. The sound comes from the laptop.

Instrument #3 in the phone-instrument set. It lives in its **own folder** (`instruments/tilt-flute/`) on `main`, fully separate from Desk Band and the other instruments. Other Claude Code sessions are working in the same repo at the same time, each in its own folder.

**Prior art, to cite rather than repeat:** *Smule Ocarina* (iPhone, 2008). You blow into the mic to play, cover four on-screen "holes" with your fingers to choose the pitch, and tilt for vibrato. **Our angle:** tilt chooses the note, so you don't need to touch the screen; scales are selectable (full major "song" mode by default, pentatonic "can't sound bad" mode); it runs in a plain web page; it belongs to a set of instruments sharing one design.

---

## Ground rules (read first)

**Do**
- Work **only inside `instruments/tilt-flute/`**.
- Commit **only your own folder**: `git add instruments/tilt-flute/`, then `git commit -m "tilt-flute: …" -- instruments/tilt-flute/`. The `-- <folder>` at the end keeps other sessions' files out of your commit. If git says `index.lock` exists, another session is committing: wait a few seconds and retry. Never delete the lock file.
- When you need shared code (`server.py`, `static/core.js`, the QR library), **copy** it into this folder and change the copy.
- Use the ports for this instrument: **HTTPS 8445** (phone) and **HTTP 8002** (laptop stage).
- Add `instruments/tilt-flute/.gitignore` containing `data/`, `.certs/`, `*.wav`, `*.m4a`, `*.webm`, `__pycache__/`.
- Keep the stack the same as Desk Band: a Python stdlib server, plain HTML and JS, no build step, no frameworks, Node for tests.
- iOS: HTTPS; call both `DeviceOrientationEvent.requestPermission()` and `DeviceMotionEvent.requestPermission()` inside a tap handler; set `echoCancellation`, `noiseSuppression` and `autoGainControl` to **false**.
- Stop at every **CHECKPOINT**, show what it lists, and wait for a go-ahead.

**Don't**
- Don't edit, move or reformat anything outside this folder (root `server.py`, `static/`, `tests/`, `README.md`, `HANDOFF.txt`, `CLAUDE.md`, `.gitignore`).
- Never run `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout` / `git switch`, `git reset`, `git restore` or `git pull`. These touch other sessions' work. Don't push; Atharva pushes.
- Don't commit raw audio.
- Don't add any machine learning. This instrument doesn't need a classifier: tilt and breath are measured directly.
- Don't use downloaded samples. Synthesise the flute voice.

---

## How it works (the plan)

```
phone tilt (beta, ~60 Hz) ──► smoothed angle ──► note step (with hysteresis) ──┐
phone roll (gamma) ───────────────────────────► vibrato / bend ──────────────┤──► laptop flute synth
phone mic ──► breath detector ──► breath level (0–1, smoothed) ─────────────────┘
```

- **Tilt to note.** Calibrate two angles first: "hold the phone where your lowest note should be" and then "hold it where your highest note should be". Split the range into N equal steps, 8 by default. Add **hysteresis**: the note only changes once the angle passes the boundary by about 2–3°, so it doesn't flicker between two notes.
- **Breath versus everything else.** Blowing on a mic makes loud, noise-like energy, strongest at low frequencies. Speech and music are *harmonic* (they have peaks). Detect breath using:
  - energy in roughly the 50–1000 Hz band; and
  - high **spectral flatness**, which separates breath from talking;
  - with a noise floor that adapts, as Desk Band's detector does.
  The breath level gets a fast attack (about 10 ms) and a gentle release (about 80 ms).
- **Flute voice (WebAudio).**
  - a sine plus a little of the 2nd and 3rd harmonics;
  - a small amount of band-passed noise for "air";
  - a 5–6 Hz vibrato LFO whose depth comes from roll;
  - a short glide (about 20–30 ms) between notes;
  - gain follows breath level.
- **Streaming.** Send `{note, breath, roll}` from the phone to the laptop **at least 30 times a second**. Start with POSTs to the copied server. If the measured lag is too high, add a minimal WebSocket endpoint to this folder's server (stdlib only). Measure; don't guess.
- **Feedback warning.** If the laptop speaker is loud and close, the phone mic may hear the flute. The flatness check should reject it because the flute tone is harmonic. Test this, and recommend headphones in the README if needed.

---

## Phase 0: Skeleton

1. Create `instruments/tilt-flute/` containing:
   - `server.py`, copied and changed to ports 8445/8002, with certificates in `instruments/tilt-flute/.certs/`;
   - `static/phone.html` and `static/stage.html`;
   - a `tests/` folder;
   - the `.gitignore` described above.
2. On the phone page, show the live tilt, roll and mic level as numbers. On the stage, show the same numbers arriving.
3. Commit.

**Status: built.** Run it from this folder:
```
python server.py              # laptop http://localhost:8002, phone https://<ip>:8445 (QR on the laptop page)
node tests/phase0_e2e.js [out-dir]   # fake phone -> server -> stage check, with screenshots (starts its own server)
```
The phone page also shows pitch and roll worked out from gravity (accelerometer), next to the orientation angles.
Orientation angles get unstable when the phone is held near upright, so Phase 1 compares the two.

### CHECKPOINT 0
- The commands to run it.
- A screenshot of the live numbers on both pages.
- `git status` showing only `instruments/tilt-flute/` changed.

---

## Phase 1: Signal test (go / no-go)

1. Build a **scripted logger** on the phone. It prompts, in random order:
   - "Hold step k for 2 s" for 8 steps, with an on-screen target angle;
   - "Blow softly 2 s", "Blow hard 2 s";
   - "Talk normally 3 s";
   - "Silence 3 s".
   It logs tilt, roll, mic features and the prompt label to `data/sessions/`.
2. Atharva runs it **twice**.
3. Report:
   - **tilt jitter** while holding a step (standard deviation in degrees), compared with the step width;
   - how often the note would flicker with hysteresis on and off;
   - **breath detection**: hits on blow prompts, and false triggers during talking and silence;
   - breath-to-level delay in ms;
   - the actual orientation update rate on his iPhone.

**Go / no-go:**
- tilt jitter below one third of the step width;
- breath detected in at least 95% of blow frames;
- fewer than 5% false triggers during talking.
If it fails, suggest fixes such as fewer steps, a wider range, or a different breath feature.

### CHECKPOINT 1
- The numbers above for both runs.
- A plot of angle over time with step boundaries.
- A plot of breath level against prompts.
- A go/no-go recommendation.

---

## Phase 2: Playable flute

1. Calibration flow (lowest angle, highest angle), saved on the phone and on the laptop.
2. Tilt to note with hysteresis; breath to gain; roll to vibrato depth, with an option to switch roll to a ±1-semitone bend.
3. The flute synth on the stage page.
4. The phone screen shows:
   - the big current note name;
   - a vertical "ladder" of all the notes with the current one lit up;
   - a breath meter.
5. Measure **latency**: tilt change to pitch change, and blow start to sound start.

### CHECKPOINT 2
- A 30-second screen recording of Atharva playing a pentatonic phrase. *Amazing Grace* (public domain) fits a major pentatonic scale and is a good test.
- The measured latencies.
- Whether laptop-speaker feedback falsely triggers breath.

---

## Phase 3: Modes and demo polish

1. **Scale modes:**
   - **Song mode** (default): the full major scale with 8 steps, C to high C, so tunes like Twinkle Twinkle work;
   - Pentatonic major or minor ("can't sound bad").
2. **Key** selector (C, D, E, G, A) and **steps** selector (5, 8 or 10).
3. Stage explainer:
   - a tilt dial with the note zones drawn on it;
   - a live breath meter;
   - a scrolling "piano roll" of the notes played in the last 8 seconds.
4. The **● Record demo** button and QR join card, copied from Desk Band.
5. Update this README with how to run it, measured results, prior art and limits.

### CHECKPOINT 3
- A screenshot.
- A 20-second recorded demo with one pentatonic jam and one song-mode tune.
- 4–5 talking points for the demo.

---

## Out of scope
- Pitch from finger holes or touch. Tilt is the point.
- Recognising which song is being played.
- Phone-only mode (sound on the phone itself). Parked: it needs headphones and a feedback test.
- Any AI/LLM, and any changes to Desk Band.

## Rough timeline
| Phase | Time |
|---|---|
| 0 Skeleton | 30 min |
| 1 Signal test | 1 hour, including 5 min of Atharva recording |
| 2 Playable | 2 hours |
| 3 Polish | 1 hour |