# pi-watchdog-supervisor — High-Level Tech Spec

- Date: 2026-07-08
- Target reader: RD / coding agent
- Source requirement: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md`
- Status: v1 — ready for user review
- Perspective: SDD（Spec-Driven Development），本文件只定義交付階段、功能目標與驗收標準，不涉及 source-code 層實作細節。

---

## 1. 需求摘要

Pi 的 task sub-agent 可能陷入重複工具迴圈（同 command、同輸出、無新 patch），目前需人工介入。本專案建立一個 Pi extension `pi-watchdog-supervisor`，以三層分工實現自動監督：

```txt
extension runtime   = 確定性事件收集器 + stuck 偵測器（規則式，非 LLM）
watchdog sub-agent  = 推理/摘要層，透過 watchdog_* tools 讀取狀態
main agent          = 最終決策者（收到 alert 後決定是否送出救援訊息）
```

預設行為：偵測 stuck → alert main agent（`main_only`）→ main agent 決定；**不**自動 kill、**不**自動 steer。

---

## 2. 架構決策（本 spec 新增）

### 2.1 觀察通道：子 session 自我回報 + 共享 state store

API 查證（見 §3）確認：Pi 核心沒有 sub-agent API，extension 只能在自己所在的 session 內運作。但 `@gotgenes/pi-subagents` 的子 agent 會**繼承父 session 的 extensions**，因此：

```txt
Task Sub-agent Session（子）
│  pi-watchdog-supervisor extension 也載入於此
│  ├─ 監聽「自己的」tool_call / tool_result 事件
│  ├─ 正規化 command、hash output
│  └─ 寫入共享 state store（以 parent session 為 key 的檔案）
│         ↓
Main Agent Session（父）
│  pi-watchdog-supervisor extension
│  ├─ 訂閱 subagents:* 生命週期事件（建立 target registry）
│  ├─ 讀取共享 store，彙整 ring buffer
│  ├─ 執行確定性 stuck 偵測 + cooldown
│  └─ 提供 watchdog_* tools 給 watchdog sub-agent
│         ↓
Watchdog Sub-agent Session
   呼叫 watchdog_* tools → 產出 compact alert → main agent
```

此設計取代了需求文件 §12.3 的「僅追蹤本 session 可見 tool calls」的降級方案，直接解決「watchdog 無法觀察兄弟 sub-agent」的核心約束（§4），且不需輪詢完整對話 log，token 成本低。

### 2.2 資料流圖

```txt
子 agent tool_call 事件
    │
    ▼
子 session extension instance（normalize + hash）
    │  append
    ▼
共享 state store（JSONL / 檔案，key = parent session id）
    │  read + aggregate
    ▼
父 session extension（ring buffer + 規則偵測 + cooldown）
    │  watchdog_* tools
    ▼
watchdog sub-agent（推理、產出 alert）
    │  watchdog_alert_main（pi.sendMessage / pi-intercom）
    ▼
main agent（決策：steer / restart / ignore）
```

---

## 3. API 查證結果（解決需求文件 §22 open questions）

查證來源：Pi extensions 官方文件、`@gotgenes/pi-subagents` 與 `pi-intercom` 套件頁（accessed 2026-07-08，URL 見 §8）。

| Open Question | 查證結果 |
|---|---|
| Pi 事件名稱 | 已確認：`tool_call`（可 block）、`tool_result`、`tool_execution_start/update/end`、`agent_start/end`、`turn_start/end`、`session_start` 等 |
| Extension 能否送訊息進 session | 可以，但**僅限自己所在的 session**：`pi.sendMessage(..., { deliverAs: 'steer' \| 'followUp' \| 'nextTurn', triggerTurn })`、`pi.sendUserMessage()` |
| Pi 核心是否有 sub-agent API | **沒有**。Extension 只在單一 session context 內運作 → 必須依賴 `@gotgenes/pi-subagents` |
| `@gotgenes/pi-subagents` API 能力 | `getSubagentsService()`、`svc.spawn(type, prompt)`、`steer_subagent(agent_id, message)`、`get_subagent_result(agent_id, wait, verbose)`（verbose 可取完整對話 log）；透過 `pi.events` 發出 `subagents:created/started/completed/failed/steered/compacted` 事件（含 agent id、type、token 數、status） |
| 跨 session 通訊 | `pi-intercom`：local broker + Unix socket，收件方 idle 時訊息會**觸發新 turn**；另有 subagent 專用 `contact_supervisor` tool（需 pi-subagents） |
| 父子關係識別 | 子 agent 繼承父的 skills/extensions；權限系統有 `subagents:child:session-created` 可作確定性子 session 偵測 |

### 仍未解之項（留給各 Task 的 low-level spec / 前置 spike）

- `SubagentsService` 完整 method 簽名（需讀套件 `src/service/service.ts` 原始碼）。→ Task02 spike
- `subagents:*` 事件是否含 per-tool-call 細節（推測不含，故採 §2.1 自我回報架構）。→ Task03 spike
- 子 session 內的 extension 如何取得 parent session id。→ Task03 spike

---

## 4. Task 拆分

對應需求文件 §17 Milestone 1–6。分類上全部屬於 `03. UI or Core Function`（新 extension 開發，無既有程式碼可 typing/refactor），測試併入各 Task 驗收。

### 估算基準

- `S` 基準 = Task01：extension 骨架 + 指令註冊 + config 載入，Pi 文件有完整範例、無外部整合風險，約 1x。
- `M` ≈ 2-3x：需整合第三方套件事件或跨多檔案，有中等不確定性。
- `L` ≈ 4-6x：跨 session 通道，最高的未知數與回歸風險。
- 倍數為規劃輔助，非時間保證。

### Task01 — Extension skeleton 與設定系統（S）

- 目標：建立 `pi-watchdog-supervisor` package（含 pi manifest）；註冊 `/watchdog status|config|set|pause|resume|inspect` 指令；載入並合併 global（`~/.pi/agent/watchdog-supervisor/config.json`）與 project（`.pi/watchdog-supervisor.json`）config，project 覆蓋 global；定義 `WatchdogConfig` 預設值（含可設定的 rescueMessage）。
- 驗收：
  - `pi -e ./src/index.ts` 啟動後 `/watchdog status` 顯示 extension 已載入。
  - `/watchdog config` 正確反映 global+project 合併結果；`/watchdog set rescueMessage <msg>` 於當前 session 生效。
  - config merge 有 unit test。

### Task02 — Sub-agent 發現與生命週期追蹤（M）

- 目標：以 optional peer dependency 整合 `@gotgenes/pi-subagents`；訂閱 `subagents:created/started/completed/failed/steered/compacted`；維護 target registry（`WatchdogTarget`）；區分 watchdog / task agent；套件缺席時 extension 仍可載入並顯示降級狀態。
- 前置 spike：讀 `@gotgenes/pi-subagents` 原始碼確認 `SubagentsService` 簽名與事件 payload。
- 驗收：
  - main session 有 2 個 task sub-agent + 1 個 watchdog sub-agent 時，`/watchdog status` 正確列出 3 個 target、kind 與 status。
  - 未安裝 pi-subagents 時無錯誤，`/watchdog status` 顯示「subagent service unavailable」。

### Task03 — 事件收集：子 session 自我回報 + 共享 store（L）

- 目標：子 session 端 extension instance 監聽自身 `tool_call`/`tool_result`；實作 `normalizeCommand()`（trim、collapse spaces、strip ANSI）與 `hashOutput()`（strip ANSI、truncate、sha256、preview N 行）；寫入以 parent session 為 key 的共享 state store；父 session 端讀取彙整為每 target 的 ring buffer（`maxEventsPerAgent`，預設 200），只存 hash 與 preview，不存完整輸出。
- 前置 spike：確認子 session 取得 parent session id 的方式；確認 `subagents:*` 事件是否已含 tool 細節（若有，可簡化架構）。
- 驗收：
  - 執行中 task sub-agent 的 tool call（含 command key、output hash）出現在父 session 的事件 buffer 中（Task05 後可經 `watchdog_read_events()` 驗證）。
  - `normalizeCommand()` / `hashOutput()` / ring buffer 有 unit test。

### Task04 — Stuck 偵測器（M）

- 目標：實作規則式偵測：同 command + 同 output hash ≥ `repeatThreshold`（3）；同 typecheck error ≥ 2；`idleNoProgressSec`（300s）內無 edit/patch 但 tools 持續執行；read-only loop。輸出 `likelyStuck` + `confidence` + `reasons` + `evidence`。實作 per-target alert cooldown（60s）與同 evidence key 去重。
- 驗收：
  - 模擬同一 `rg` 指令重複 3 次（同輸出）→ `likelyStuck === true`、confidence ≥ medium、evidence 含 `repeated_command`。
  - cooldown 期間相同 evidence 不重複產生 alert。
  - 各偵測規則與 cooldown 有 unit test。

### Task05 — Watchdog tools（M）

- 目標：以 `pi.registerTool` 註冊需求文件 §9 全部工具：`watchdog_list_targets`、`watchdog_read_events`、`watchdog_detect_stuck`、`watchdog_alert_main`（優先 `pi.sendMessage` 注入 main session；pi-intercom 為跨 session 備援；最後 fallback UI 通知）、`watchdog_steer_subagent`（預設 `dryRun=true`，實際 steer 走 pi-subagents `steer_subagent`）、`watchdog_config`。輸出 schema 依需求文件 §9 定義。
- 驗收：
  - watchdog sub-agent 能呼叫 `watchdog_detect_stuck` 取得 evidence 並產出 §8.2 格式的 compact alert。
  - `watchdog_alert_main` 的訊息實際出現在 main session。
  - `watchdog_steer_subagent` 預設 dry-run 不實際送訊息。

### Task06 — Supervisor 工作流與文件（M）

- 目標：提供 watchdog agent prompt（`prompts/watchdog-agent.md`）、watchdog skill（§21）、範例 main-agent 指引（examples/AGENTS.md）；實作 main-agent-driven 輪詢流程（需求文件 §14 Option A）；README 與手動情境測試腳本（dummy loop agent 重複 `rg` 3 次）。
- 驗收：
  - 端到端手動測試：dummy task sub-agent 進入迴圈 → watchdog 偵測 → main agent 收到 `[Watchdog Alert]` → main agent 可選擇送出 rescue message（人工確認送達）。
  - Extension-driven tick（Option B）明確標記為 post-MVP，不在本次交付。

---

## 5. 釋出安全性

每個 Task 完成後皆可獨立釋出，不需等待後續 Task：

- Task01–03 只收集資料、不產生任何 alert 或介入，對現有工作流零影響。
- Task04–05 預設 `alertMode: "main_only"`、steer 預設 dry-run，不會自動介入 sub-agent。
- 整體可用 `enabled: false` 或 `/watchdog pause` 一鍵停用。

---

## 6. 風險表（依查證結果更新需求文件 §24）

| Risk | Impact | 變化 | Mitigation |
|---|---:|---|---|
| Pi 不暴露 sub-agent 內部 | Medium（原 High） | ↓ 已緩解 | 查證確認子 agent 繼承 extensions → 採自我回報架構（§2.1） |
| 子 session 無法識別 parent id | Medium | 新增 | Task03 前置 spike；備援：pi-intercom 註冊回報 |
| `@gotgenes/pi-subagents` API 與文件不符 | Medium | 新增 | Task02 spike 直接讀原始碼；adapter 隔離於 `integrations/` |
| Watchdog sub-agent 閒置 | Medium | 不變 | MVP 採 main-agent-driven（Option A），Option B 為 post-MVP |
| 誤報過多 | Medium | 不變 | cooldown、confidence 分級、main agent 最終審批 |
| 監控造成 token 浪費 | Low（原 Medium） | ↓ | 只存 hash + preview；watchdog 只讀 compact 資料 |
| 第三方 extension API 變動 | Medium | 不變 | adapter 隔離於 `integrations/` |

---

## 7. Revision History

| Version | Change |
|---|---|
| v1 | 初版：API 查證結果 + 觀察通道架構決策 + Task01–06 拆分與驗收標準 |

---

## 8. Reference

- reference01: https://pi.dev/docs/latest/extensions — 事件清單、registerTool/registerCommand、sendMessage/sendUserMessage、無 sub-agent API（accessed 2026-07-08）
- reference02: https://pi.dev/packages/%40gotgenes/pi-subagents — service API、subagents:* 事件、steering、extension 繼承（accessed 2026-07-08）
- reference03: https://pi.dev/packages/pi-intercom — broker 架構、turn 觸發、contact_supervisor（accessed 2026-07-08）
- reference04: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` — 原始需求文件
