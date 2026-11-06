# Desk Band

**Turn any table into a drum kit, using only the phone already in your pocket.**

Lay your phone flat on a table and knock the wood around it. The phone listens with its **microphone** and feels the jolt with its **motion sensor**, works out *which spot* you hit and *how hard*, and your laptop plays a drum, dhol or marimba note for that spot. No magnets, no stickers, no extra hardware.

**Status: v0.2.** v0 was played on a real iPhone and worked. Feedback from that session:
1. A bit of lag.
2. You had to wait about half a second between notes.
3. Too many knocks landed on pad 1.
4. No chords.

v0.2 fixes:
- **Notes can follow every ~0.1 s** (was ~0.5 s). The detector now listens to overlapping knocks, the dead time is 90 ms instead of 200 ms, a rising-edge check stops ringing tails from re-firing, and anti-echo is off by default.
- **Lag:** the phone's listening delay is down to ~60 ms (was ~100 ms), with a **Response** setting (Fast / Balanced / Accurate) that trades speed for accuracy. The laptop shows the measured delay.
- **Accuracy:**
  - **guided training** prompts spots in a random order, 15 each, so the model can't learn "the knocks I did in a row";
  - you're told to mix soft and hard knocks;
  - **fix-it-while-you-play:** tap the right pad on the phone after a wrong note and it learns from that knock.
- **Chords:** a new kit where each spot strums a full chord (C, G, Am, F), plus **MIDI out** (Chrome/Edge) to play real instruments in GarageBand or Ableton.

Tested in the browser with the real recording as the mic. The offline tests cover rapid-fire knocks (8 per second, all caught).

| Response setting | Phone listening delay | Accuracy on recording #3 |
|---|---|---|
| Fast (30 ms) | ~45 ms | ~71% |
| Balanced (45 ms) | ~61 ms | ~77% |
| Accurate (70 ms) | ~84 ms | ~80% |

Why it works, from our own tests (iPhone 17, 4 spots about 20 cm from the phone, 15 taps per spot):

| Sensor | Accuracy on a *separate* pass, in a different order |
|---|---|
| Accelerometer only | 66% |
| Microphone only | 76% |
| **Both** | **82%** (random guessing = 25%) |

That run used 16 kHz compressed audio, so lossless audio should only help. The browser version of the same pipeline scores 79–88% on that recording with 10–15 training taps per spot.

**Prior art, to cite rather than repeat:**
- **Mogees** (2014): turned any surface into an instrument, but needed a separate contact sensor plugged into the phone.
- **Vibrative** (Florian Kräutli, 2012): typed on a table using a jailbroken iPhone 4's accelerometer, about 80% accuracy.
- Research on around-device input (magnets, ultrasound, Elliptic Labs).

**Our angle:** zero accessories, mic plus motion fused, runs in a plain web page, and is meant to work on any iPhone or Android.

---

## Run it (v0)

Needs Python 3.9+ on the laptop. The certificate is made automatically. If that fails: `pip install cryptography`.

1. On the laptop: `python3 server.py`. It prints two links.
2. **Laptop:** open `http://localhost:8000` and click **Start sound**.
3. **Phone** (Safari or Chrome): open the `https://<laptop-ip>:8443` link.
   - It warns that the connection isn't private. That's our own self-signed certificate. Tap **Show Details → visit this website**.
   - Tap **Start sensors** and allow the microphone and motion.
4. Lay the phone flat, top edge pointing away from you. Pick 4 spots about 20 cm away: top-left (1), top-right (2), bottom-right (3), bottom-left (4).
5. On the phone, press **Teach all spots**. It calls out spots in a random order (15 each, about 1 minute): knock the spot shown, mixing soft and hard knocks. It then shows an estimated accuracy. To add more taps to just one spot, tap that pad.
6. Press **Play**, and knock. If it plays the wrong pad, tap the right pad on the phone and it learns from that knock.
7. On the laptop: switch kits (drums, desi, marimba, chords, melody, or **My chords**). Keys 1–4 also play the pads.
   - **Edit my chords:** type note names per pad, like `A3 C4 E4` (a low note in the list works as a bass note).
   - Choose the sound (pluck or keys), ringing or short stabs, and strummed or all at once.
   - Press Enter in a box to preview. It's saved in the browser. **MIDI out** (Chrome/Edge) sends notes to GarageBand or Ableton:
   - **Mac:** in Audio MIDI Setup, turn on the IAC Driver.
   - **Windows:** install loopMIDI.

**If it doesn't work**
- **Same Wi-Fi:** the phone and laptop must be on the same network. Office or guest Wi-Fi often blocks device-to-device traffic. If so, connect the laptop to your phone's hotspot.
- **Firewall:** allow Python through the laptop firewall when asked.
- **Sensitivity slider:** lower catches softer taps, higher ignores more noise. Watch the meter: knocks should jump past the yellow line.
- **Anti-echo** is off by default. Turn it on only if the laptop's speakers sit on the same table and you hear notes playing by themselves. It slows fast playing a little.
- Type the full `https://` address on the phone. A plain `http://` visit is now redirected automatically.
- Touching the phone screen pauses detection for 0.8 s, because touching it shakes it.

---

## Demo it (online meeting)

The laptop page is built to be screen-shared:
- **Join card:** the phone scans a QR code. No typing IPs.
- **Training saved on the laptop:** after you teach it once, a fresh phone page loads the taps and is ready to **Play** straight away. Files live in `data/training/`.
- **Explainer panel:** for every knock it shows:
  - the waveform the phone heard;
  - each spot's **sound fingerprint**, with this knock drawn over all four (the matched one lights up);
  - how sure it was, per pad;
  - a scrolling timeline of the last 8 seconds.
- **Camera:** an optional webcam card, so people see your hand and the pad light together.
- **● Record demo:** records this tab plus the instrument's sound to a `.webm` file. Pick **"This tab"** when Chrome asks.

**In the call:**
1. Share the **Desk Band tab** (not the whole screen), with **"Also share tab audio"** ticked (Meet). In Zoom it's "Share sound"; in Teams, "Include computer sound".
2. Wear **headphones**, so the phone doesn't hear the call or the drums through the laptop speakers.

---

## How it works

```
knock ─► phone mic (high-pass, onset detector) ─► 75 ms snippet ─► 18-band spectrum shape + loudness ─┐
      └► phone motion sensor (±80 ms around the knock) ─► jolt direction + strength ──────────────────┤
                                                                                                       ▼
                         small logistic-regression model (trained on your 12 taps per spot, in the browser)
                                                                                                       ▼
                               {zone, confidence, velocity} ─► POST /hit ─► server ─► SSE ─► laptop synth
```

- `static/core.js`: the onset detector, features (FFT bands, motion features) and the classifier. No dependencies. It runs in the browser **and** in Node, so it can be tested offline.
- `static/phone.html`: sensors, guided training, play mode, data export.
- `static/stage.html`: laptop visual plus synthesised kits (drums, desi, marimba). No audio files.
- `server.py`: standard library only. It serves HTTPS for the phone (mic and motion need HTTPS) and HTTP for the laptop, and relays hits.

---

## How to use this README (for Claude Code)

- Work **one phase at a time**. At each **CHECKPOINT**, stop, show what it asks for, and wait for a go-ahead.
- Keep the stack plain: Python standard library on the server, vanilla JS in the pages, no frameworks, no build step. Ask before adding any dependency.
- `core.js` is shared by the phone and the tests. Any change to it must keep the offline test passing.
- If a sanity check fails, stop and report. Don't paper over it.

## Ground rules

**Do**
- Label every recording automatically. The phone page prompts the spot, so labels come from the prompt, never from memory or hand-labelling.
- Test on held-out data that was **recorded separately** (a different pass, a different order), never on random splits of one pass. Taps recorded close together look alike.
- Keep a frozen copy of every recording session used for a reported number (`data/sessions/*.json`).
- Measure latency and accuracy together. A more accurate model that feels laggy is worse.

**Don't**
- Don't claim a number from a single session.
- Don't commit personal audio. Exported tap features are fine; raw room audio stays local.
- Don't add AI or LLM calls. This project is signal processing plus a tiny classifier, on purpose.

---

## Repo layout

```
desk-band/
  README.md  server.py  .gitignore
  static/  core.js  phone.html  stage.html
  CLAUDE.md  HANDOFF.txt         # context for Claude Code: start with HANDOFF.txt
  static/vendor/qrcode.js        # QR code library (MIT), so the join QR works offline
  tests/   test_core.js          # offline synthetic test (detection, classification, 8 knocks/sec)
  tools/   analysis/             # Python scripts used on the phyphox + voice-memo recordings
           browser-tests/        # Playwright tests that feed a WAV as a fake phone mic
  data/    sessions/             # exported tap features (+ labels), never raw audio
           training/             # laptop copy of training taps (gitignored)
  docs/    index.html            # Phase 4 demo page (not yet)
```

---

## Phase 0: v0 on a real phone (done in code; Atharva to try)

1. Run it as above, with 4 spots and 12 taps each.
2. Play for 2 minutes and note how often it plays the wrong pad, plus anything that feels off (lag, missed soft taps, double triggers).
3. Press **Export taps** and keep the JSON.

### CHECKPOINT 0
Show:
- The estimated accuracy shown on the phone.
- How it feels: lag, misses, double hits.
- The exported JSON.
- Anything broken: certificate, network, permissions.

---

## Phase 1: Feel (latency, accuracy, chords)

**Goal:** make it feel like an instrument, not a doorbell. v0.2 already did the shorter listening window, the Response setting, small audio blocks, guided training and live correction.

1. **Measure end-to-end latency.** Record a session where the phone hears both the knock and the laptop's sound. The gap between the two onsets is the real total (listening + Wi-Fi + laptop speakers). Report the median and p90 for each Response setting, and for Mac vs Windows if possible.
2. **Distinct objects trick:** compare 4 spots on bare wood vs 4 *different objects* (the table, a book, a cardboard box, a mug). Different materials should sound far more distinct. Report accuracy for both.
3. **Combo chords** (two spots knocked together): teach "1+3 together" as its own extra pad. Can one phone tell a double knock from a single one? Go/no-go: at least 70% on combos without hurting single-pad accuracy.
4. **Soft taps:** add a motion-sensor trigger as a backup for taps the mic misses (spot 3 was quiet on the mic in our test).
5. **Velocity:** check that hit strength maps sensibly to volume, using a soft / medium / hard tapping session.
6. **Pad-1 bias check:** with guided training, play 100 prompted knocks and report the confusion matrix. If one pad still soaks up wrong guesses, try class balancing or dropping the loudness feature.

### CHECKPOINT 1
Show:
- The end-to-end latency table.
- Bare-wood vs different-objects accuracy.
- The combo-chord go/no-go.
- The missed-tap rate, mic-only vs mic+motion trigger.
- The confusion matrix.
- A recommended default setup.

---

## Phase 2: Robustness study (does it survive real life?)

Add a **guided session recorder** to the phone page: it prompts spots in a random order, shows the prompt, and saves `{features, prompted_zone, session_id, condition}`. Then record and test:

| Test | Question |
|---|---|
| Same setup, next day | Does a model trained yesterday still work? |
| Phone moved 5 cm or rotated | How much retraining is needed? |
| Different table (wood vs glass vs laminate) | Does the surface matter? |
| 6 spots, then 8 | Where does accuracy fall off? |
| Spots 10 cm vs 20 cm vs 40 cm away | How far can you go? |
| Finger pad vs knuckle vs pen | Does the "striker" matter? |
| Phone in a case vs bare | Does it dampen the signal? |
| **An Android phone** (Chrome) | Does it work on any phone? |

Report each test as accuracy on a separately recorded session, plus how many retraining taps it takes to recover.

### CHECKPOINT 2
Show:
- The robustness table with sessions per condition.
- A chart of accuracy vs number of spots.
- The Android result.
- A recommendation for the "default kit" (number of spots, distance).

---

## Phase 3: Expression (make it a real instrument)

Do each step separately, with its own small go/no-go:
1. **Loop recorder:** knock the table edge twice to start or stop a loop, then layer beats over it.
2. **Hand-height control (theremin):** your hand above the phone bends pitch or sweeps a filter.
   - Try **web sonar** first: the phone plays a quiet, near-inaudible tone, and the mic tracks the echo off your hand.
   - Check that it doesn't interfere with tap detection.
   - On iPhone, compare with phyphox's depth sensor (a quick prototype via phyphox remote access).
   - Go/no-go: does it track a hand smoothly at 5–30 cm?
3. **Tap position on a line, not just in zones:** a "slider" along the table edge, if Phase 2 shows enough resolution.

### CHECKPOINT 3
Show:
- A short screen recording of each feature working.
- The theremin go/no-go numbers (tracking error, any interference with taps).

---

## Phase 4: Demo for anyone, any phone (GitHub Pages)

1. **Phone-only mode:** the phone page alone, hosted on GitHub Pages. That gives it HTTPS, so there's no certificate warning. Sound plays on the phone through **headphones**; the phone speaker would trigger the mic. Anyone can open the link and play their own table.
2. `docs/index.html`, the landing page:
   - a 20-second video of playing the table;
   - **Try it** (phone-only mode);
   - how it works (the diagram above, with real signal plots);
   - the robustness results;
   - prior art (Mogees, Vibrative);
   - limits.
3. Keep the laptop "stage" mode for live demos.

### CHECKPOINT 4
Show:
- The phone-only link working on an iPhone **and** an Android.
- That every number on the page comes from `data/sessions` reports.
- That the limits are clearly listed.

---

## Rough timeline

| Phase | Time |
|---|---|
| 0 Try v0 | 1 hour |
| 1 Feel | 1 day |
| 2 Robustness study | 1–1½ days |
| 3 Expression | 1–2 days (theremin is the risky part) |
| 4 Demo | 1 day |

## Out of scope (for now)
- More than one phone at a time, and syncing several phones.
- A native iOS or Android app.
- Any AI/LLM.

---

## Parallel track: the phyphox experiment backlog

These are weekend-sized experiments that use the sensors phyphox exposes. Each one is a quick test first, and a project only if it surprises us. Phyphox's **remote access** lets Python on the laptop read live sensor data, so most prototypes are a page of code.

| # | Experiment | Sensor | The fun bit |
|---|---|---|---|
| 1 | **Room events from air pressure** | Barometer | A door closing or the AC kicking in shows up as a pressure blip. Log your flat's day with no camera. |
| 2 | **Stair counter / "how tall is my building"** | Barometer | Walk the stairs and the phone counts steps and floors from pressure alone. |
| 3 | **Appliance stethoscope** | Accelerometer (spectrum) | Phone on the washing machine, fridge or desk near a fan: each appliance hums at its own frequency. Identify what's running from vibration. |
| 4 | **Ball bounce lab** | Mic (acoustic stopwatch) | Drop a cricket, tennis or ping-pong ball. The gaps between bounce sounds give its bounciness. Compare balls and surfaces. *(Sports!)* |
| 5 | **Air theremin, iPhone shortcut** | Depth sensor via phyphox | Hand distance → laptop synth via remote access. A quick taste of Desk Band Phase 3. |
| 6 | **Sonar ruler** | Speaker + mic | The phone measures distance to a wall from its own echo. |
| 7 | **Doppler speedometer** | Mic | Measure how fast a sound source (a ceiling fan blade, a toy) is moving from the pitch shift. |
| 8 | **Spin challenge** | Gyroscope | Put the phone on a spinning chair or a lazy Susan and get the max RPM leaderboard. |
| 9 | **Magnet ring controller** | Magnetometer | Revisit once there's a magnet in the house (MagSafe accessories have a ring of them). |
| 10 | **Heartbeat on your chest** | Accelerometer | Lie down with the phone on your chest and see your heartbeat as tiny jolts. Just for fun, **not** a medical tool. |

Pick 2–3, do them in an evening each, and keep the ones that make people say "wait, what?".
