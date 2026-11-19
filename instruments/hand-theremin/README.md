# Hand Theremin (no camera)

**Hold your hand above the phone to play. Higher hand = higher note. No camera: the phone uses sonar.**

The phone lies flat on the table. Its speaker plays a quiet, very high sound (around 18–21 kHz) that most people can't hear, and its microphone listens for the echo off your hand.
- **How long** the echo takes to come back tells us **how high** your hand is.
- **How the echo's pitch shifts** (the Doppler effect) tells us **how fast** your hand is moving.

Hand height sets the note, and taking your hand away silences it. The sound comes from the laptop.

Instrument #4 in the phone-instrument set. It lives in its **own folder** (`instruments/hand-theremin/`) on `main`, fully separate from Desk Band and the other instruments. Other Claude Code sessions are working in the same repo at the same time, each in its own folder.

**This is the risky one.** Doppler alone only gives *speed*, not *height*, and a theremin needs height. Height needs echo timing, which is harder: the speaker's sound reaches the mic directly and is far louder than the echo, and the table and your body echo too. Phase 1 is therefore a strict go/no-go. If it fails, we fall back (see Phase 1). We do **not** switch to the camera without asking Atharva.

**Prior art, to cite rather than repeat** (check each citation before putting it in the README):
- *SoundWave* (Microsoft Research, CHI 2012): Doppler on an 18–22 kHz tone using a laptop's own speaker and mic to sense hand gestures.
- Browser Doppler demos that scroll a page or play a theremin.
- Active-sonar finger tracking on phones, for example *FingerIO* (CHI 2016) and *LLAP* (MobiCom 2016).

**Our angle:** a playable instrument, in a plain web page on an ordinary iPhone, part of a set, with a live "echo map" that shows the phone seeing your hand.

---

## Run it (Phase 0: sonar check, no music yet)

```
cd instruments/hand-theremin
python server.py                 # laptop http://localhost:8003, phone https://<ip>:8446 (QR on the laptop page)
node tests/test_sonar.js         # offline: the sonar maths on a simulated mic
node tests/phase0_e2e.js [dir]   # headless Chrome: phone + laptop pages, fake mic and simulated hand
```

1. Phone and laptop on the same Wi-Fi. Open the laptop page, scan the QR, accept the certificate warning.
2. Lay the phone **flat, screen up**, volume up, silent mode off. Tap **Start sonar** and keep your hand away for 1 s.
3. Watch the **echo map** on the laptop: up = farther above the phone, left to right = the last 8 seconds.
   A hand held still at 10 cm should draw a bright flat line at 10 cm; moving it up and down makes the line climb and fall.
4. "Chirp heard" must say **yes**. If not: volume up, silent mode off.

**Hearing note:** most adults can't hear 18–21 kHz, but some people, especially younger ones, and pets can.
Keep the volume as low as still gives "Chirp heard: yes", stop if it bothers anyone, and never use headphones.

`?sim` on the phone URL replaces the mic with a simulated one (direct path, body echo, a pretend hand at 10, 20 and
30 cm, then a sweep). It is for tests and for seeing what a working echo map looks like. It proves nothing about a real hand.

---

## Ground rules (read first)

**Do**
- Work **only inside `instruments/hand-theremin/`**.
- Commit **only your own folder**: `git add instruments/hand-theremin/`, then `git commit -m "hand-theremin: …" -- instruments/hand-theremin/`. The `-- <folder>` at the end keeps other sessions' files out of your commit. If git says `index.lock` exists, another session is committing: wait a few seconds and retry. Never delete the lock file.
- When you need shared code (`server.py`, the QR library), **copy** it into this folder and change the copy.
- Use the ports for this instrument: **HTTPS 8446** (phone) and **HTTP 8003** (laptop stage).
- Add `instruments/hand-theremin/.gitignore` containing `data/`, `.certs/`, `*.wav`, `*.m4a`, `*.webm`, `__pycache__/`.
- Keep the stack the same as Desk Band: a Python stdlib server, plain HTML and JS, no build step, no frameworks, Node for tests.
- iOS: HTTPS; ask for permission inside a tap handler; set `echoCancellation`, `noiseSuppression` and `autoGainControl` to **false**. Use an `AudioContext` at 48 kHz if available, and report the actual sample rate.
- **Keep the sonar quiet.** Use a moderate output level, put a fade-in and fade-out on every chirp (clicks are audible), and add a big **Stop sonar** button. Note in the README that some people, especially younger ones, and pets can hear 17–19 kHz.
- Stop at every **CHECKPOINT**, show what it lists, and wait for a go-ahead.

**Don't**
- Don't edit, move or reformat anything outside this folder.
- Never run `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout` / `git switch`, `git reset`, `git restore` or `git pull`. These touch other sessions' work. Don't push; Atharva pushes.
- Don't commit raw audio. Echo profiles and reports go in `instruments/hand-theremin/results/`.
- Don't use the camera or a depth sensor in the instrument.
- Don't play the sonar through headphones.

---

## How it works (the plan)

```
phone speaker ──► repeating chirp (e.g. 18→21 kHz, ~10 ms, every ~20–40 ms)
phone mic ──► cross-correlate with the chirp ──► echo profile (strength vs distance)
          ──► subtract the static background (table, body, direct path)
          ──► strongest moving peak = hand distance ──► smoothing ──► laptop synth
          └─► Doppler shift around the carrier (optional) ──► hand speed
```

- At 48 kHz, one sample of delay is about **3.6 mm** of hand distance (343 m/s ÷ 48 000 ÷ 2), so the resolution is plenty. The hard parts are the direct path and other reflections, not resolution.
  One caveat: with a 3 kHz-wide chirp, two echoes closer than about **5.7 cm** (343 m/s ÷ 2 ÷ 3 kHz) blur into one wide band
  on the echo map. A single hand's peak can still be placed much more finely than that, but the hand search has to start
  about 5 cm above the phone, because the speaker's own sound smears up to there.
- **Background subtraction.** Measure the echo profile with no hand for about 1 s, then subtract it, or use a slowly updating average. A hand is the thing that *changes*.
- **Presence.** Echo energy above the background is the "hand present" gate. No hand means silence.
- **Mapping.** 5–30 cm maps to the notes. "Easy mode" snaps to the pentatonic scale; "theremin mode" glides continuously.

---

## Phase 0: Quick check plus skeleton

1. **Atharva, about 3 minutes:** run the echo-map check above (it replaced the phyphox Sonar check, which was hard to read). Hold a hand at about 10, 20 and 30 cm. Note whether the hand shows up and whether the distance roughly makes sense. Report: a screenshot of the laptop page and "yes / sort of / no".
2. Create `instruments/hand-theremin/` containing:
   - `server.py`, copied and changed to ports 8446/8003, with certificates in `instruments/hand-theremin/.certs/`;
   - `static/phone.html` and `static/stage.html`;
   - a `tests/` folder;
   - the `.gitignore` described above.
3. Phone page: a **Start sonar** button that plays the chirp and records the mic, plus a **Stop sonar** button.
4. Commit.

### CHECKPOINT 0
- The echo-map check result.
- The commands to run it.
- `git status` showing only this folder changed.
- The phone's actual sample rate, and whether the chirp is audible to Atharva.

---

## Phase 1: Signal test (strict go / no-go)

1. Compute the echo profile on the phone and show it as a live **echo map**: distance on the y-axis, time on the x-axis, brightness for echo strength. A hand moving up and down should draw a visible line. This picture alone is worth showing.
2. A scripted test with a ruler or a stack of books:
   - hold the hand still at **5, 10, 15, 20 and 30 cm** for 3 s each, in random order, with on-screen prompts;
   - then move the hand slowly up and down for 10 s.
   Log the estimated distances to `data/sessions/`.
3. Try a few variations, briefly:
   - two chirp settings (band and length);
   - phone face up vs face down;
   - flat hand vs fist.
4. Report:
   - error against the ruler at each height;
   - jitter while still;
   - update rate;
   - how far away the hand is still detected;
   - whether the room or a moving body causes false detections.

**Go / no-go:** tracks a hand at **5–30 cm** with error below **2 cm**, jitter below **1 cm**, and at least **20 updates a second**.

**If no-go, try these fallbacks in order and report each one:**
- (a) the **laptop's** own speaker and mic as the sonar, with the hand above the keyboard;
- (b) a **Doppler-only** instrument: hand *speed* controls a "swoosh" or pitch bend, with no height;
- (c) stop and ask Atharva.

Never switch to the camera on your own.

### CHECKPOINT 1
- A screenshot or recording of the echo map with a hand moving.
- The ruler error and jitter table.
- The chirp settings that worked best.
- A go/no-go recommendation, or fallback results.

---

## Phase 2: Playable theremin

1. Height to pitch:
   - easy mode (snap to pentatonic) and theremin mode (glide);
   - range calibration (low and high hand height);
   - smoothing that keeps lag low; report it.
2. Presence to volume, with a soft fade in and out.
3. Synth on the stage page:
   - a sine or soft saw with vibrato and a little reverb, for a classic theremin sound;
   - a marimba option in easy mode.
4. Stream `{distance, present, speed}` to the laptop at least 30 times a second. Measure the end-to-end lag.

### CHECKPOINT 2
- A 30-second screen recording of Atharva playing in both modes.
- Measured lag.
- How it behaves when the hand leaves and comes back.

---

## Phase 3: Demo polish

1. Stage explainer:
   - the live echo map;
   - a hand-height bar with note zones;
   - a speed (Doppler) meter, if built.
2. The **● Record demo** button and QR join card, copied from Desk Band.
3. Update this README with how to run it, measured results, prior art (citations checked), limits and the hearing note.

### CHECKPOINT 3
- A screenshot.
- A 20-second recorded demo.
- 4–5 demo talking points.

---

## Out of scope
- Camera or depth-sensor tracking.
- Two-hand control (pitch and volume on separate hands, as on a real theremin). Parked until one hand works.
- Recognising gestures.
- Any AI/LLM, and any changes to Desk Band.

## Rough timeline
| Phase | Time |
|---|---|
| 0 Quick check + skeleton | 45 min |
| 1 Signal test | 2–4 hours (the risky part) |
| 2 Playable | 2 hours |
| 3 Polish | 1 hour |