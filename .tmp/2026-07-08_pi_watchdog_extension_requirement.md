# Pi Watchdog Supervisor Extension — Requirement & Tech Spec

- Date: 2026-07-08
- Target reader: coding agent / implementation engineer
- Status: Draft for review
- Goal: design a Pi extension that lets a `watchdog` sub-agent supervise sibling task sub-agents and report likely stuck/loop states to the main agent session.

---

## 1. Problem

Current Pi agent / sub-agent workflow can get stuck in repetitive tool loops, such as:

```txt
same rg / grep command
same output
no new patch
no new plan
manual user intervention required
```

The user wants an automated mechanism where:

```txt
main agent session
├─ watchdog sub-agent session
├─ task sub-agent session 1
└─ task sub-agent session 2
```

The watchdog sub-agent detects whether task sub-agents are stuck, then notifies the main agent or suggests a rescue action.

---

## 2. Core Requirement

### 2.1 Functional Goals

- Provide a Pi extension that can observe sub-agent activity.
- Allow the main agent to spawn or use a dedicated `watchdog` sub-agent.
- The watchdog sub-agent must be able to inspect summarized status/events of sibling task sub-agents.
- When a task sub-agent is likely stuck, the watchdog should report to the main agent.
- The main agent decides whether to:
  - send rescue message to task sub-agent,
  - stop / restart task sub-agent,
  - ask the task sub-agent to summarize and re-plan,
  - ignore the alert.

### 2.2 User-defined Rescue Message

Default:

```txt
AI agent 是不是卡死了?
請停止目前重複動作，總結你已知的資訊，重新規劃下一步。
不要再執行相同 command，除非 query 或 path 有改變。
```

Must be configurable per project and per session.

---

## 3. Non-goals

- Do not let watchdog sub-agent directly read private context of sibling sub-agents unless Pi/subagent API explicitly exposes it.
- Do not rely only on LLM reasoning for deterministic timeout / repeat-count detection.
- Do not require MCP for MVP.
- Do not require GUI automation such as `xdotool`.
- Do not auto-kill task sub-agents by default.

---

## 4. Important Design Constraint

A watchdog sub-agent is still an LLM session. It cannot magically observe sibling sub-agents.

Therefore the architecture must include a shared observation channel:

```txt
task sub-agent events
  ↓
pi-watchdog extension runtime
  ↓
watchdog sub-agent tools
  ↓
watchdog sub-agent analysis
  ↓
main agent alert
```

The extension runtime is the deterministic collector. The watchdog sub-agent is the reasoning / summary layer.

---

## 5. Proposed Architecture

```txt
Pi Main Agent Session
│
├─ Watchdog Sub-agent Session
│  ├─ uses watchdog_list_targets()
│  ├─ uses watchdog_read_events()
│  ├─ uses watchdog_detect_stuck()
│  └─ sends alert to main agent
│
├─ Task Sub-agent Session 1
│  └─ emits lifecycle/tool/progress events
│
├─ Task Sub-agent Session 2
│  └─ emits lifecycle/tool/progress events
│
└─ pi-watchdog-supervisor extension
   ├─ listens to Pi events
   ├─ integrates with pi-subagents service if available
   ├─ stores compact event history
   ├─ computes deterministic stuck signals
   ├─ exposes watchdog tools
   └─ optionally routes alert through pi-intercom / subagent steering
```

---

## 6. Package Name

Suggested package:

```txt
pi-watchdog-supervisor
```

Alternative names:

```txt
pi-subagent-watchdog
pi-watchdog-extension
pi-agent-supervisor
```

---

## 7. Extension Responsibilities

### 7.1 Event Collection

The extension should collect:

- sub-agent created / started / completed / failed / steered / compacted events.
- tool call events.
- tool result summaries, if available.
- last active time.
- command string for bash / shell tools.
- output hash, not full output by default.
- patch/write/edit count.
- repeated command count.
- repeated output count.
- current status text, if available.

### 7.2 Event Normalization

Normalize commands before comparison:

```txt
trim whitespace
collapse repeated spaces
remove ANSI escape codes
optional: normalize temp paths
optional: normalize line numbers if needed
```

Normalize output:

```txt
strip ANSI
truncate to max bytes
hash normalized output with sha256
store first N lines as preview only
```

### 7.3 Stuck Detection

MVP stuck signals:

```txt
same command + same output hash >= 3 times
same type-check error >= 2 times
no patch/edit/write event for >= N minutes while tools keep running
read-only loop: rg / grep / cat / ls repeated without plan change
sub-agent heartbeat active, but progress score unchanged
```

Default thresholds:

```json
{
  "repeatThreshold": 3,
  "typecheckRepeatThreshold": 2,
  "idleNoProgressSec": 300,
  "cooldownSec": 60,
  "maxPreviewLines": 20,
  "maxEventsPerAgent": 200
}
```

---

## 8. Watchdog Sub-agent Role

The watchdog sub-agent should not monitor raw logs itself. It should call extension-provided tools.

### 8.1 Suggested Watchdog Prompt

```md
You are a watchdog supervisor for Pi task sub-agents.

Your job:
- Check task sub-agent status through watchdog tools.
- Detect likely loop/stuck cases.
- Report compact alerts to the main agent.
- Do not fix code yourself unless explicitly asked.
- Do not spam alerts; respect cooldown.
- Prefer evidence-based alerts.

When reporting a stuck task, include:
- sub-agent id/name
- reason
- repeated command or error summary
- last activity time
- suggested rescue message
```

### 8.2 Alert Format

```txt
[Watchdog Alert]

Target: task-sub-agent-1
Status: likely stuck
Confidence: high

Evidence:
- same command repeated 3 times
- same output hash repeated 3 times
- no patch/edit event in 6 minutes

Last command:
rg "CAMPAIGN_RULES_QUERY_KEY" apps/campaign-list

Suggested rescue:
AI agent 是不是卡死了?
請停止目前重複動作，總結你已知的資訊，重新規劃下一步。
不要再執行相同 command，除非 query 或 path 有改變。
```

---

## 9. Tools Exposed by Extension

### 9.1 `watchdog_list_targets`

List sub-agents visible to the current main session.

Input:

```ts
type Input = {
  includeCompleted?: boolean;
};
```

Output:

```ts
type Output = {
  targets: Array<{
    id: string;
    name?: string;
    kind: 'task' | 'watchdog' | 'unknown';
    status: 'running' | 'completed' | 'failed' | 'unknown';
    lastActiveAt?: string;
    toolCallCount: number;
    patchCount: number;
    repeatedCommandCount: number;
    likelyStuck: boolean;
  }>;
};
```

### 9.2 `watchdog_read_events`

Read compact recent events for one target.

Input:

```ts
type Input = {
  targetId: string;
  limit?: number;
  sinceEventId?: string;
};
```

Output:

```ts
type Output = {
  targetId: string;
  events: WatchdogEvent[];
};
```

### 9.3 `watchdog_detect_stuck`

Return deterministic stuck analysis.

Input:

```ts
type Input = {
  targetId: string;
};
```

Output:

```ts
type Output = {
  targetId: string;
  likelyStuck: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  evidence: Array<{
    type: 'repeated_command' | 'repeated_output' | 'idle_no_progress' | 'typecheck_loop';
    summary: string;
  }>;
  suggestedRescueMessage: string;
};
```

### 9.4 `watchdog_alert_main`

Send a compact alert to the main agent session.

Input:

```ts
type Input = {
  targetId: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
};
```

MVP behavior:

- Append a message / notification to the main session if Pi API supports it.
- Otherwise use pi-intercom if installed.
- Otherwise print a visible extension UI notification.

### 9.5 `watchdog_steer_subagent`

Optional. Send rescue message to target sub-agent.

Input:

```ts
type Input = {
  targetId: string;
  message: string;
  dryRun?: boolean;
};
```

Default:

```txt
dryRun = true
```

Reason: main agent should approve direct intervention first.

### 9.6 `watchdog_config`

Read or update policy.

Input:

```ts
type Input = {
  action: 'get' | 'set';
  config?: Partial<WatchdogConfig>;
};
```

---

## 10. Internal Data Model

```ts
type WatchdogConfig = {
  enabled: boolean;
  rescueMessage: string;
  repeatThreshold: number;
  typecheckRepeatThreshold: number;
  idleNoProgressSec: number;
  cooldownSec: number;
  maxPreviewLines: number;
  maxEventsPerAgent: number;
  alertMode: 'main_only' | 'direct_subagent' | 'both';
};

type WatchdogTarget = {
  id: string;
  parentSessionId: string;
  name?: string;
  kind: 'task' | 'watchdog' | 'unknown';
  status: 'running' | 'completed' | 'failed' | 'unknown';
  createdAt: number;
  lastActiveAt: number;
  lastCommandKey?: string;
  lastOutputHash?: string;
  repeatedCommandCount: number;
  repeatedOutputCount: number;
  toolCallCount: number;
  editCount: number;
  lastAlertAt?: number;
};

type WatchdogEvent = {
  id: string;
  targetId: string;
  at: number;
  type:
    | 'subagent_created'
    | 'subagent_started'
    | 'subagent_completed'
    | 'subagent_failed'
    | 'tool_call'
    | 'tool_result'
    | 'edit'
    | 'patch'
    | 'alert';
  summary: string;
  commandKey?: string;
  outputHash?: string;
  outputPreview?: string;
};
```

---

## 11. Config Files

Global config:

```txt
~/.pi/agent/watchdog-supervisor/config.json
```

Project config:

```txt
.pi/watchdog-supervisor.json
```

Project config overrides global config.

Example:

```json
{
  "enabled": true,
  "rescueMessage": "AI agent 是不是卡死了? 請停止重複動作，總結已知資訊並重新規劃。",
  "repeatThreshold": 3,
  "typecheckRepeatThreshold": 2,
  "idleNoProgressSec": 300,
  "cooldownSec": 60,
  "alertMode": "main_only"
}
```

---

## 12. Integration Options

### 12.1 Preferred: `@gotgenes/pi-subagents`

Use when available because it provides in-process sub-agent core, lifecycle events, typed API, and steering support.

Expected integration points:

```ts
const { getSubagentsService } = await import('@gotgenes/pi-subagents');
const svc = getSubagentsService?.();
```

Use cases:

- enumerate subagents,
- observe lifecycle events,
- read status/transcripts if exposed,
- steer a running subagent,
- identify parent/child relationships.

Implementation note:

- Treat this dependency as optional peer dependency.
- Extension must still load when this package is absent.

### 12.2 Optional: `pi-intercom`

Use as a message broker when cross-session message routing is needed.

Use cases:

- send alert from watchdog sub-agent to main session,
- send rescue message from main session to task sub-agent,
- coordinate if task sub-agents are separate Pi sessions instead of in-process children.

### 12.3 Fallback: Pi Events + Tool Hooks

If subagent service is unavailable:

- listen to Pi lifecycle events,
- listen to `tool_call`,
- track visible tool calls in current session,
- expose partial watchdog status only.

### 12.4 Fallback: External Daemon / Log Parser

Out of MVP scope, but useful if Pi API does not expose enough sub-agent internals.

---

## 13. Main Agent Supervisor Flow

```txt
1. User asks main agent to run work with sub-agents.
2. Main agent starts watchdog sub-agent.
3. Main agent starts task sub-agent 1 and task sub-agent 2.
4. Extension records sub-agent events.
5. Watchdog sub-agent periodically calls watchdog tools.
6. Watchdog detects task-sub-agent-1 likely stuck.
7. Watchdog alerts main agent.
8. Main agent decides whether to steer task-sub-agent-1.
9. If approved, extension sends rescue message to task-sub-agent-1.
```

---

## 14. Periodic Watchdog Execution

Important: a watchdog sub-agent does not run continuously by itself unless the runtime keeps prompting it.

MVP options:

### Option A: Main-agent driven

Main agent periodically asks watchdog sub-agent to check status.

Pros:

- simpler,
- safer,
- no timer injection needed.

Cons:

- if main agent forgets, watchdog is idle.

### Option B: Extension-driven tick

Extension periodically sends a compact prompt to watchdog sub-agent:

```txt
Check current task sub-agent status. Report only if likely stuck.
```

Pros:

- closer to real watchdog behavior.

Cons:

- needs reliable Pi API for sending messages into sub-agent sessions.
- must avoid spamming / token waste.

Recommended MVP: Option A first, then Option B.

---

## 15. Safety & Anti-spam

- Alert cooldown per target: default 60 seconds.
- Do not send direct rescue message unless `alertMode` allows it.
- Default alert mode is `main_only`.
- Store output hash and short preview only; avoid storing large command output.
- Avoid repeated alerts for same evidence key.
- Ignore completed / failed sub-agents unless explicitly requested.
- Provide `/watchdog pause` and `/watchdog resume` commands.

---

## 16. Commands

### `/watchdog status`

Show current targets and stuck signals.

### `/watchdog config`

Show current config.

### `/watchdog set rescueMessage <message>`

Update rescue message for current session.

### `/watchdog pause`

Disable alerting temporarily.

### `/watchdog resume`

Enable alerting.

### `/watchdog inspect <targetId>`

Show recent compact event summary.

---

## 17. MVP Milestones

### Milestone 1 — Basic Extension Skeleton

- Create Pi package / extension.
- Register `/watchdog status` command.
- Register `watchdog_list_targets` tool.
- Load global/project config.

Acceptance:

```txt
pi -e ./src/index.ts
/watchdog status
```

shows extension is loaded.

### Milestone 2 — Sub-agent Discovery

- Integrate with `@gotgenes/pi-subagents` if installed.
- List running sub-agents.
- Mark watchdog sub-agent vs task sub-agent.

Acceptance:

```txt
main session has 2 task sub-agents + 1 watchdog sub-agent
/watchdog status lists all 3 correctly
```

### Milestone 3 — Event Collection

- Listen to lifecycle events.
- Listen to tool calls.
- Record command key and output hash if available.
- Store compact event ring buffer.

Acceptance:

```txt
running task sub-agent tool calls appear in watchdog_read_events()
```

### Milestone 4 — Stuck Detection

- Implement repeated command/output detector.
- Implement idle no-progress detector.
- Implement cooldown.

Acceptance:

```txt
a task sub-agent repeating same rg command 3 times is marked likelyStuck=true
```

### Milestone 5 — Watchdog Sub-agent Tools

- Add `watchdog_detect_stuck`.
- Add `watchdog_alert_main`.
- Add `watchdog_steer_subagent` dry-run.

Acceptance:

```txt
watchdog sub-agent can call watchdog_detect_stuck and produce compact alert
```

### Milestone 6 — Main Agent Supervisor Mode

- Provide recommended watchdog sub-agent prompt.
- Provide sample main-agent workflow.
- Ensure main agent receives alert before direct intervention.

Acceptance:

```txt
watchdog sub-agent detects stuck task
main agent receives alert
main agent can choose to send rescue message
```

---

## 18. Suggested File Structure

```txt
pi-watchdog-supervisor/
├─ package.json
├─ README.md
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ events.ts
│  ├─ detector.ts
│  ├─ tools.ts
│  ├─ commands.ts
│  ├─ integrations/
│  │  ├─ gotgenes-subagents.ts
│  │  ├─ pi-intercom.ts
│  │  └─ fallback.ts
│  └─ types.ts
├─ prompts/
│  └─ watchdog-agent.md
└─ examples/
   ├─ AGENTS.md
   └─ watchdog-supervisor.json
```

---

## 19. Example `package.json` Pi Manifest

```json
{
  "name": "pi-watchdog-supervisor",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "typebox": "latest"
  },
  "peerDependenciesMeta": {
    "@gotgenes/pi-subagents": {
      "optional": true
    },
    "pi-intercom": {
      "optional": true
    }
  },
  "pi": {
    "extensions": [
      "./src/index.ts"
    ],
    "skills": [
      "./skills/watchdog-supervisor.md"
    ]
  }
}
```

---

## 20. Example Main Agent Instruction

```md
## Sub-agent watchdog workflow

When running multiple background sub-agents:

1. Start one watchdog sub-agent.
2. Start task sub-agents normally.
3. Ask watchdog sub-agent to periodically inspect task sub-agent status using watchdog tools.
4. If watchdog reports likely stuck, decide whether to steer the task sub-agent.
5. Prefer sending a rescue message before stopping/restarting a sub-agent.
```

---

## 21. Example Watchdog Skill

```md
# Watchdog Supervisor

Use this skill when supervising task sub-agents.

Steps:
1. Call `watchdog_list_targets`.
2. Ignore yourself and completed agents.
3. For each running task agent, call `watchdog_detect_stuck`.
4. If likely stuck, call `watchdog_read_events` for evidence.
5. Report a compact alert to the main agent.
6. Do not directly steer unless explicitly allowed.
```

---

## 22. Open Questions for Coder

Need verify from Pi runtime/source:

- Exact event names for tool results, message updates, and sub-agent lifecycle.
- Whether extension can send a message directly into a sub-agent session.
- Whether `@gotgenes/pi-subagents` exposes enough service API for listing and steering sub-agents.
- Whether watchdog sub-agent can be scheduled/ticked by extension safely.
- How to identify parent-child relationship across sub-agent sessions.
- Whether pi-intercom is enough for cross-session alerts.
- Whether output content can be accessed or only tool call metadata is exposed.

---

## 23. Testing Plan

### Unit Tests

- `normalizeCommand()`
- `hashOutput()`
- repeated command detection
- repeated output detection
- cooldown handling
- config merge: global + project

### Integration Tests

- extension loads in Pi.
- sub-agents are discovered.
- repeated tool calls generate stuck signal.
- watchdog tool returns evidence.
- alert is routed to main session.

### Manual Scenario Test

Create a dummy sub-agent that loops:

```txt
Run `rg "SOME_TOKEN" src` three times without changing query/path.
```

Expected:

```txt
watchdog_detect_stuck(targetId).likelyStuck === true
main agent receives [Watchdog Alert]
```

---

## 24. Risks

| Risk | Impact | Mitigation |
|---|---:|---|
| Pi does not expose enough sub-agent internals | High | Use `@gotgenes/pi-subagents` service API or pi-intercom |
| Watchdog sub-agent stays idle | Medium | Start with main-agent-driven checks; add extension tick later |
| Too many false positives | Medium | Use cooldown, confidence levels, and main-agent approval |
| Token waste from monitoring | Medium | Store compact summaries and hashes only |
| Direct rescue causes bad intervention | Medium | Default to `main_only` alert mode |
| Third-party extension API changes | Medium | Keep adapters isolated under `integrations/` |

---

## 25. Recommended MVP Decision

Build this as a Pi extension, but keep roles separate:

```txt
extension runtime = event collector + deterministic detector
watchdog sub-agent = reasoning/reporting layer
main agent = final decision maker
```

Default behavior:

```txt
Detect stuck → alert main agent → main agent decides rescue
```

Not default:

```txt
Detect stuck → auto steer task sub-agent
```

---

## 26. Reference Materials

- Pi Documentation — Extensions, latest docs, extension locations, imports, command registration, accessed 2026-07-08.
  - https://pi.dev/docs/latest/extensions
- Pi extension examples README, includes examples for lifecycle events, `tool_call`, `send-user-message.ts`, `event-bus.ts`, and `subagent/`, accessed 2026-07-08.
  - https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md
- `@gotgenes/pi-subagents` package page, in-process sub-agent core, typed API, lifecycle events, steering, accessed 2026-07-08.
  - https://pi.dev/packages/%40gotgenes/pi-subagents
- `pi-intercom` package page, local IPC broker, direct messages between Pi sessions, incoming messages can trigger a turn, accessed 2026-07-08.
  - https://pi.dev/packages/pi-intercom
- Pi Documentation — Packages, package manifest and install/config behavior, accessed 2026-07-08.
  - https://pi.dev/docs/latest/packages
- Pi Documentation — SDK, programmatic agent session/events overview, accessed 2026-07-08.
  - https://pi.dev/docs/latest/sdk
