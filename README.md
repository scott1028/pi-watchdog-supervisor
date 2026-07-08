# pi-watchdog-supervisor

A [Pi](https://pi.dev) extension that lets a **watchdog sub-agent** supervise
sibling task sub-agents and report likely stuck/loop states to the main agent
session.

Typical failure it catches: a task sub-agent re-running the same `rg`/`grep`
command, getting the same output, producing no new edits — forever.

## Architecture

Three layers with separate responsibilities:

```txt
Every Session (main AND child — children inherit parent extensions)
│  ├─ listens to its OWN llm events (before_provider_request / message_end)
│  │    and tool_call / tool_result events
│  ├─ normalizes message bodies (timestamps/ids stripped), hashes them
│  ├─ appends compact events to a process-shared store
│  └─ event-driven self-check on every LLM round-trip:
│       detect stuck on own buffer → steer rescue message into itself
│       (no timer, no watchdog sub-agent needed)
│        ↓
Main Agent Session (parent)
│  this extension
│  ├─ tracks sub-agent lifecycle (@gotgenes/pi-subagents events)
│  ├─ runs deterministic stuck detection + cooldown
│  └─ receives [Watchdog Alert] messages via an alert sink
│        ↓
Watchdog Sub-agent Session (optional, for cross-agent supervision)
   calls watchdog_* tools → analyzes → alerts the main agent
```

- **Extension runtime** = deterministic collector + detector (no LLM guessing
  for repeat counts / timeouts).
- **Watchdog sub-agent** = reasoning/reporting layer (uses the tools below).
- **Main agent** = final decision maker; nothing is auto-killed or auto-steered
  by default.

## Requirements

- `@gotgenes/pi-subagents` (optional peer dependency) — without it the
  extension still loads, but target discovery is unavailable.

## Install

```bash
pi install npm:pi-watchdog-supervisor      # once published
# or for local development:
pi -e ./src/index.ts
```

## Commands

| Command | Behavior |
|---|---|
| `/watchdog status` | List targets with kind/status/tool count and stuck flag |
| `/watchdog config` | Show effective config (defaults ← global ← project ← runtime overrides) |
| `/watchdog set rescueMessage <msg>` | Override the rescue message for this run |
| `/watchdog pause` | Suppress alerting temporarily |
| `/watchdog resume` | Re-enable alerting |
| `/watchdog inspect <targetId>` | Show recent compact events + stuck analysis for one target |

## Tools (for the watchdog sub-agent)

| Tool | Purpose |
|---|---|
| `watchdog_list_targets` | List sub-agents with status and `likelyStuck` signal |
| `watchdog_read_events` | Read compact recent events (commands, output hashes, edits) |
| `watchdog_detect_stuck` | Deterministic stuck analysis + `suggestedRescueMessage` |
| `watchdog_alert_main` | Send a `[Watchdog Alert]` into the main session |
| `watchdog_steer_subagent` | Send a rescue message to a target (defaults to dry-run) |
| `watchdog_config` | Read/update policy at runtime |

## Stuck detection rules

Detection works at the LLM message level (same sources as the lm-debug
widget): `before_provider_request` captures the newest message sent to the
provider, `message_end` captures each finalized assistant message. Bodies are
normalized before hashing — timestamps, dates, UUIDs, long hex ids, and digit
runs are replaced with placeholders — so two loop iterations that differ only
in time or sequence markers compare as identical.

- `repeated_llm_input`: the same normalized input body sent to the LLM ≥
  `llmRepeatThreshold` (3) times in a row.
- `repeated_llm_output`: the same normalized assistant output body (text +
  thinking + tool calls with arguments) ≥ `llmRepeatThreshold` times in a row.
- `idle_no_progress`: tools keep running but no edit/write for ≥
  `idleNoProgressSec`. **Disabled by default** (`0`); set a positive number of
  seconds (e.g. `300`) to enable.

Setting `llmRepeatThreshold` to `0` disables the LLM repetition rules. The
repeats must be consecutive; a different message in between resets the run.
Confidence: one evidence type → `medium`, two or more → `high`.

## Safety & anti-spam

- `alertMode`:
  - `main_only` (default): only shows an alert message in the main session;
    nothing is sent to the stuck sub-agent (no extra AI provider message).
  - `direct_subagent` / `both`: additionally allow `watchdog_steer_subagent`
    to send the rescue message into the stuck sub-agent (with
    `dryRun: false`; the tool defaults to dry-run).
  - `dryRun` is a parameter of the `watchdog_steer_subagent` tool call,
    passed by the watchdog agent per invocation. When the call omits it, the
    `steerDryRunDefault` config field decides:
    - `null` (default) or `true`: dry-run.
    - `false`: steer for real without a per-call `dryRun: false` — opt-in to
      fully automatic rescue (still requires `alertMode` other than
      `main_only`).
    - An explicit `dryRun` in the call always wins over the config default.
- Alerts respect a per-target cooldown (`cooldownSec`):
  - `0` (default): no cooldown — every check that meets the threshold alerts.
  - `-1`: infinite cooldown — the same evidence key alerts only once; new
    evidence still alerts.
  - `> 0`: the same evidence key is not re-alerted within that many seconds;
    new evidence still alerts immediately.
- The repetition counter resets at each alert: only llm messages recorded
  after the last alert count toward the next one. A recovered agent stops
  alerting immediately; an agent still looping re-accumulates the threshold
  within a few round-trips.
- `/watchdog pause` suppresses all alerts until `/watchdog resume` (including
  the automatic tick).
- Only output hashes and short previews are stored, never full outputs.
- Besides the watchdog-agent-driven flow (Option A), the extension runs an
  event-driven self-check in every session (Option B): each session (main or
  child) re-runs stuck detection on its own event buffer on every LLM
  round-trip — after each `before_provider_request` / `message_end` llm event
  and on `after_provider_response` — and steers the rescue message into itself
  the moment the threshold is crossed. No timer is involved. The check
  respects `enabled`, `cooldownSec`, and the pause state.

## Configuration

Project config `.pi/watchdog-supervisor.json` overrides global config
`~/.pi/agent/watchdog-supervisor/config.json`. See
[examples/watchdog-supervisor.json](examples/watchdog-supervisor.json) for all
fields (values match the defaults, except `idleNoProgressSec` which is shown
enabled at `300`; its default is `0` = disabled). The default `rescueMessage`
asks the agent to stop repeating the current actions and resume the task —
override it per project or per session as needed.

Set `debug: true` (default `false`) to show a debug console below the editor
with the latest message sent to the provider and the latest assistant message
received, each timestamped, in full (newlines preserved, no truncation).

## Manual E2E scenario

Prerequisites: `@gotgenes/pi-subagents` installed, this extension loaded
(`pi -e ./src/index.ts`), API key available.

1. In the main session, spawn a watchdog sub-agent using
   [prompts/watchdog-agent.md](prompts/watchdog-agent.md) plus
   "supervise the task agents".
2. Spawn a dummy loop task sub-agent:
   `Repeat the exact same step five times: run `rg "SOME_TOKEN" src` and
   report the result with the same sentence each time.`
3. After the task agent has looped a few turns, prompt the watchdog:
   "Check task sub-agent status now."
4. Expected:
   - `watchdog_list_targets` shows the task agent with `likelyStuck: true`
   - `watchdog_detect_stuck` returns `repeated_llm_input` /
     `repeated_llm_output` evidence
   - `watchdog_alert_main` puts a `[Watchdog Alert]` into the main session
5. Main agent decides: ask the watchdog to run `watchdog_steer_subagent`
   (dry-run by default); real steering requires
   `watchdog_config set { "alertMode": "both" }` first.

## Development

```bash
npm install
npm run type-check
npm test
pi -e ./src/index.ts
```
