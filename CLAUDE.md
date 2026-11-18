# Desk Band: notes for Claude Code

**Start here:** read `HANDOFF.txt` (full history, results, architecture, gotchas, next steps), then `README.md` (phased plan with checkpoints).

## Working rules
- **Work one phase at a time.** At every CHECKPOINT, stop, show the results, and wait for Atharva's go-ahead.
- **Before building a new direction,** explain it plainly, then ask him 2–3 quick questions to check he understands what it is and what it's for.
- **Keep it plain:**
  - Python standard library on the server;
  - vanilla JS in the pages;
  - no frameworks, no build step;
  - no AI or LLM calls.

  Ask before adding any dependency.
- **`static/core.js` is shared** by the phone page and the tests. After changing it, run `node tests/test_core.js`, and rerun the recording test if there's data for it.
- **Never commit raw audio or recordings.** Exported tap features are fine. `.certs/` and `data/training/` stay gitignored.
- **Report accuracy honestly:**
  - only from separately recorded, prompted sessions;
  - never from random splits of one session;
  - never from the phone's own estimate, which is optimistic.
- **Labels always come from prompts.** No manual labelling.
- **Commits and pushes** go to his personal GitHub (`atharva-729`).

## Quick commands
```
python3 server.py                     # laptop http://localhost:8000, phone https://<ip>:8443 (QR on the laptop page)
node tests/test_core.js               # offline core test
node tools/browser-tests/pads_e2e.js [out-dir]     # fake-mic phone + laptop, 4/5/6/8 pads (starts its own server)
node tools/browser-tests/pentatonic.js [out-dir]   # every Pentatonic combination at every pad count
node tools/analysis/read_log.js data/training/log-<date>.jsonl   # what happened in a live session
```

## Status
Desk Band is **parked at v0.3** (README "New in v0.3"). The repo is next used for other phone-sensor instruments.
If Desk Band is picked up again: README Phase 2 (quick recalibrate) is next, and a full Check round is still
needed for a measured accuracy number on 5 pads.

## Keep it personal
This is a personal project. No names of other people or organisations in files or commit messages.
Private notes (`HANDOFF.txt`, `QUICK_WINS.md`) stay local and gitignored.
