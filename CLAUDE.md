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
NODE_PATH=$(npm root -g) node tools/browser-tests/e2e_demo.js <fake-mic.wav> <out-dir>   # with server running
```

## Next up
Publish to GitHub, then generalise from 4 to N pads (6–8, using the laptop and monitor as pads), then README Phase 1. See HANDOFF.txt §8.
