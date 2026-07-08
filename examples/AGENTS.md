# Example main-agent instructions

Copy the section below into your project's `AGENTS.md` to enable the
supervisor workflow.

---

## Sub-agent watchdog workflow

When running multiple background sub-agents:

1. Start one watchdog sub-agent using the prompt in
   `prompts/watchdog-agent.md` (from the pi-watchdog-supervisor package).
2. Start task sub-agents normally.
3. Periodically ask the watchdog sub-agent to inspect task sub-agent status
   ("Check task sub-agent status now.") — the watchdog uses the
   `watchdog_list_targets` / `watchdog_detect_stuck` / `watchdog_read_events`
   tools and reports via `watchdog_alert_main`.
4. If the watchdog reports a likely stuck task, decide whether to steer the
   task sub-agent.
5. Prefer sending a rescue message before stopping/restarting a sub-agent.
   Direct steering via `watchdog_steer_subagent` requires setting
   `alertMode` to `direct_subagent` or `both` first (default is `main_only`).

Note (MVP / Option A): the watchdog sub-agent does not wake up by itself —
the main agent drives the check cadence. An extension-driven periodic tick
(Option B) is post-MVP.
