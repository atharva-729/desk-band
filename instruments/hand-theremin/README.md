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

## Run it

```
cd instruments/hand-theremin
python server.py                 # laptop http://localhost:8003, phone https://<ip>:8446 (QR on the laptop page)
node tests/test_sonar.js         # offline: the sonar maths on a simulated mic
node tests/test_theremin.js      # offline: height -> note (range, hysteresis, dropouts, smoothing)
node tests/phase0_e2e.js [dir]   # headless Chrome: phone + laptop pages, fake mic and simulated hand
node tools/replay.js data/sessions/<id>   # replay a saved phone session: per-second table + <id>-replay.png
```

Each run is saved on the laptop in `data/sessions/` (gitignored): `<id>.jsonl` (per-frame readings, taps, audio clock)
and `<id>.pcm` (the raw mic audio, 16-bit). Untick "Save this session" on the phone to turn it off. Never commit these.

1. Phone and laptop on the same Wi-Fi. Open the laptop page, scan the QR, accept the certificate warning.
2. Lay the phone **flat, screen up**, volume up, silent mode off. Tap **Start sonar** and keep your hand away for 1 s.
   Play over the phone's **bottom edge** (speaker grille end): that's where the speaker and mic are.
3. Watch the **echo map** on the laptop: up = farther above the phone, left to right = the last 8 seconds.
   A hand held still at 10 cm should draw a bright flat line at 10 cm; moving it up and down makes the line climb and fall.
4. "Chirp heard" must say **yes**. If not: volume up, silent mode off.

**Playing (with a book, for now).** A hand only tracks to about 14 cm, too tight to play, so the instrument is played
with a book held flat over the bottom edge, which tracks to about 36 cm. On the laptop page: **Enable sound**, hold the book
where the lowest note should be and click **Set low note here**, then where the highest should be and **Set high note here**
(no ruler needed; it's saved in the browser). **Easy** plays 8 pentatonic notes, C4 to E5; **Theremin** glides C3 to C5.
Voices: theremin (sine and a little triangle, vibrato, reverb) or marimba (easy mode). Taking the book away fades the note
out; dropouts under 0.4 s hold it. The page shows an estimated lag from the phone's reading to the sound, worked out from the
measured parts (about 110–150 ms in headless Chrome, most of it smoothing and audio output).

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

**First iPhone run (observed by eye, nothing saved yet):**
- Hand over the **top** (earpiece) end: flickered between "5 cm" and nothing, so not seen. The 5 cm is the edge of the
  search zone, so that's noise, not the hand.
- Hand over the **bottom** (speaker) end: seen, roughly.
- A **thick book** over the bottom end: a steady line moving from 15 to 10 cm.
- **Bug:** the page re-measured the table on its own whenever the strongest echo wasn't the speaker's own sound. A hand
  or book right over the speaker echoes louder than that, so it re-measured with the hand in view and broke every
  reading after. Fixed: it now re-measures only when you tap **Re-measure** (after a 2 s countdown). "Chirp heard" is
  judged at the speaker's own echo, and a test covers an echo twice as loud as the speaker.

**Second iPhone run, 2026-11-19 (75 s saved session: book first, then hand; replay in `results/2026-11-19_book-then-hand.*`).**
Distances are the sonar's own estimate; nothing was checked against a ruler yet.
- **Book:** steady holds read at about 10, 14, 20 and 25 cm. Found in 100% of frames at 14 and 20 cm, about 50% at
  10 cm, and only 10–45% at 25 cm, which is the edge of its range at this volume. A still book wobbles 0.4–1.7 cm within a second.
- **Hand:** read from about 2 to 13.6 cm, found in 80–100% of frames there. Above about 14 cm it drops out (47%, then 4%).
- **Below 5 cm:** the hand search started at 5 cm, so a closer hand was pinned at exactly "5.0 cm". Replaying the same
  audio with the search starting at 2 cm gives 2.1–4.6 cm for those seconds, with no false hands when nothing was
  there. The default is now 2 cm. (The "typical change" the hand must beat is still measured from 5 cm up; measuring it
  lower made the book at 20 cm drop out.)
- **Louder than the speaker:** a hand within about 8 cm echoed louder than the speaker's own sound in 40–47 of 47 frames
  a second. The first build re-measured the table whenever that happened, so the bug fix was needed.
- **The phone kept up:** 47 echo profiles a second, no dropped audio in 75 s, chirp heard 38–51 dB above the floor at 30%
  volume. Peak mic level was −60 dBFS with the hand away and −51 dBFS with it close, so there's headroom to turn the volume up.

**Third iPhone run, 2026-11-19, 100% volume (109 s: book, then hand; `results/2026-11-19_volume-100_*`).** The chirp
was not audible to Atharva at 100%.
- **Volume trap:** the volume went from 30% to 100% after the table was measured, so the hand read a flat 2.1 cm until
  Re-measure was tapped (0–18 s). Fixed: changing the volume now re-measures the table after the 2 s countdown.
- **Book:** a steady lift from 15 to **36 cm**, found in 50–100% of frames (about 25 cm at 30% volume).
- **Hand:** 3–14 cm again, then it drops out: **the same ceiling as at 30%.**
- **Why more volume didn't help the hand:** the speaker's own sound came in 21 dB louder, but the "change" on an empty
  stretch of the map (15–30 cm, nothing there) stayed −13 to −24 dB relative to it, the same as at 30%. So the floor
  isn't mic hiss. It's echoes that change on their own (arm and body shifting, air, the room), and they scale with the
  volume like the hand does. A hand's echo sinks to that level at about 13–15 cm. The book is a bigger reflector and
  stays above it to about 36 cm.

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