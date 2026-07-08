---
name: watchdog-supervisor
description: |
  Supervise Pi task sub-agents for stuck/loop states. Use when acting as a
  watchdog sub-agent, or as a main agent coordinating task sub-agents with a
  watchdog. Detects repeated LLM input/output message bodies (timestamps and
  ids normalized away) and idle-without-progress via deterministic watchdog tools, then reports
  compact alerts to the main session.
---

# Watchdog Supervisor

Use this skill when supervising task sub-agents.

## Steps

1. Call `watchdog_list_targets`.
2. Ignore yourself and completed agents.
3. For each running task agent, call `watchdog_detect_stuck`.
4. If likely stuck, call `watchdog_read_events` for evidence.
5. Report a compact alert to the main agent via `watchdog_alert_main`.
6. Do not directly steer unless explicitly allowed — `watchdog_steer_subagent`
   defaults to dry-run, and real steering is refused while `alertMode` is
   `main_only`.

## Notes

- Alerts respect a per-target cooldown (`cooldownSec`: `0` default = no
  cooldown, `-1` = same evidence alerts once, `>0` = seconds) and the
  pause state (`/watchdog pause`); a suppressed alert returns a clear reason.
- The repetition counter resets at each alert: only llm messages after the
  last alert count toward the next one.
- `watchdog_detect_stuck` output includes `suggestedRescueMessage` — include it
  in the alert so the main agent can forward it as-is.
- Read or tune policy with `watchdog_config` (`action: "get" | "set"`).
