# e2e

Scenarios in `scenarios/` are written for a test agent (e.g. a Haiku subagent) that drives the rig
in `scripts/e2e.mjs` from a shell. Each tab name (A, B, …) is a separate browser profile: a separate
participant with its own storage.

```sh
node scripts/e2e.mjs up            # dev server on a scratch copy of live/ + headless browser
node scripts/e2e.mjs A goto        # open the app in tab A (or: A goto '#room=…')
node scripts/e2e.mjs A eval "() => location.hash"
node scripts/e2e.mjs B wait "() => document.querySelector('.session')" 10000
node scripts/e2e.mjs A console     # console output and page errors since the last call
node scripts/e2e.mjs down
```

Run `node scripts/e2e.mjs` without arguments for every command. A rig nobody stops shuts itself down after
`E2E_IDLE_MIN` minutes without a command (default 20, `0` = never), so a forgotten `down` doesn't keep a
browser and dev server alive. In the page,
`__redaw.runtime.loader.get('<path under live/>')` is a live module's namespace.

Every tab's console, page errors (with stacks), crashes and failed requests also go to one central
log, `e2e/out/<run>/events.jsonl`. Each line is `{t, tab, kind, text}`, and `status` names the file.
`node scripts/e2e.mjs log '<text>'` adds a note to that log. The `init` op adds a script that runs
before the page's own code in a tab: `{tab, op: 'init', script}` on the control port.

`stress.mjs` (see `stress/README.md`) is a scripted multi-peer stress test on the same rig.

## Briefing a test agent

> Run the scenario in `e2e/scenarios/<name>.md` with the rig `node scripts/e2e.mjs` (run it without
> arguments for usage; the rig is already up). Use only that command. Poll with `wait` instead of
> failing on a first check. Don't fix the app. Report each step's evidence briefly and end with
> `E2E RESULT: PASS` or `E2E RESULT: FAIL: <reason>`, including `console` output on failure.
