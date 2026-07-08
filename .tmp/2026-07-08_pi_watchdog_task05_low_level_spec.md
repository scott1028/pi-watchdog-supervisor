# Task05 — Watchdog Tools：Low-Level Detail Spec

- Date: 2026-07-08
- Source: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task05）；requirement §8.2, §9, §15
- Status: v1 — 使用者已指示直接實作
- Perspective: TDD
- 前置：Task01–04 已完成並 commit（`929c823`）

---

## 1. 核心設計約束

**Tools 是在 watchdog 子 session 的 instance 上執行的**（watchdog sub-agent 呼叫 tool → 該子 session 的 extension instance 的 `execute` 跑）。因此：

1. **alert 通道**：子 instance 的 `pi.sendMessage()` 只會送進**自己的** session。解法：父 instance 於載入時把「alert sink」closure（包住父的 `pi.sendMessage`）註冊進共享 store；子 instance 的 `watchdog_alert_main` 透過 store 呼叫 sink → 訊息進 main session。
2. **runtime 狀態共享**：`paused`、`rescueMessageOverride`、config 覆寫必須移入共享 store，否則父端 `/watchdog pause` 對子端 tool 無效。→ `src/state.ts` 廢除，職責併入 store（Task01 的 state 測試改寫為 store 測試）。
3. **steer**：in-process 直接用 `getSubagentsService().steer(agentId, message)`（Task02 adapter 擴充）。

### 簡化決策（記錄偏離）

- requirement §9.4 的 pi-intercom 備援**不實作**：MVP 架構下父子同 process，parent sink 必然存在；跨 process 場景在 MVP 範圍外（維持高階 spec 判斷）。sink 缺席時（理論上只在測試）回傳明確錯誤訊息。

---

## 2. 範圍

### In scope

- `src/tools.ts`：以 `pi.registerTool` 註冊 6 個 tools（requirement §9 schema）。
- `src/store.ts` 擴充：`setPaused/isPaused`、`setRescueMessage/getRescueMessage`、`setConfigOverride/getConfigOverride`、`setAlertSink/alert`。
- `src/state.ts` 移除，`src/commands.ts` 的 pause/resume/set 改走 store；`test/state.test.ts` 併入 `test/store.test.ts`。
- alert 格式：requirement §8.2 `[Watchdog Alert]` 樣板。

### Out of scope

- watchdog agent prompt / skill / 範例工作流（Task06）；Option B tick。

---

## 3. Tools 定義（parameters 用 `Type.Object`；typebox 來源實作時查證 — pi 文件範例 `import { Type } from "typebox"`，若 pi-coding-agent 有 re-export 則優先）

### 3.1 `watchdog_list_targets`

- Input：`{ includeCompleted?: boolean }`（default false → 過濾 status ∈ completed/aborted/stopped/error）。
- 行為：`getIntegration()` → `syncFromRecords` → registry.list() → 每個 target 併 `detectStuck` 的 `likelyStuck`。
- Output（text JSON）：requirement §9.1 欄位（`repeatedCommandCount` 以 detector 的 repeated_command evidence 有無簡化為 boolean 對映數值 0/N — 從 evidence summary 取 count）。

### 3.2 `watchdog_read_events`

- Input：`{ targetId: string; limit?: number }`（`sinceEventId` 不實作 — ring buffer 已限幅且 MVP 用不到，記錄為偏離）。
- 行為：`store.resolveTargetKey` → `getEvents(key, limit ?? 50)`。

### 3.3 `watchdog_detect_stuck`

- Input：`{ targetId: string }`。
- 行為：resolve → `detectStuck(events, effectiveConfig, Date.now())`。
- Output：requirement §9.3 + `suggestedRescueMessage`（= store rescueMessage override ?? config.rescueMessage）。

### 3.4 `watchdog_alert_main`

- Input：`{ targetId: string; message: string; severity?: 'info'|'warning'|'critical' }`。
- 行為：
  1. `store.isPaused()` → 回 `alert suppressed (watchdog paused)`。
  2. `detectStuck` 當前分析 → `shouldAlert(store.getLastAlert(targetId), analysis, now, cooldownSec)`；false → 回 `alert suppressed (cooldown)`。（likelyStuck=false 時仍允許發送 — watchdog agent 可能有 deterministic 規則外的觀察；此時跳過 cooldown 去重、不 recordAlert，記錄為設計決策）
  3. `store.alert(formatAlert(...))` → 父 sink `pi.sendMessage({ customType: 'watchdog-alert', content, display: true }, { deliverAs: 'nextTurn', triggerTurn: severity === 'critical' })`（實際 options 以 dist 型別為準）。
  4. likelyStuck 時 `store.recordAlert(targetId, evidenceKey, now)`。
- `formatAlert`：requirement §8.2 樣板（Target/Status/Confidence/Evidence/Last command/Suggested rescue）。

### 3.5 `watchdog_steer_subagent`

- Input：`{ targetId: string; message?: string; dryRun?: boolean }`（default dryRun=**true**；message default = effective rescueMessage）。
- 行為：`alertMode === 'main_only'` 且 `dryRun !== false` 維持 dry-run；dry-run 回傳「would steer <id> with: <message>」；實際執行走 integration 的 `steer(agentId, message)`（targetId 若為 sessionId 需反查 agentId — store 增 `resolveAgentId`）。
- `alertMode === 'main_only'` 時即使 `dryRun: false` 也拒絕實際 steer（回覆要求先改 config）— requirement §15「Do not send direct rescue message unless alertMode allows it」。

### 3.6 `watchdog_config`

- Input：`{ action: 'get' | 'set'; config?: Partial<WatchdogConfig> }`。
- get → effective config（base + store override）JSON；set → `store.setConfigOverride(merge)`（只允許 `WatchdogConfig` 已知欄位，沿用 `loadConfigFile` 的白名單邏輯抽出共用）。

---

## 4. 實作步驟（TDD）

1. **store 擴充**（紅→綠）：paused/rescue/configOverride/alertSink/alert/resolveAgentId roundtrip 測試；`state.ts` 刪除、commands 改接 store、`test/state.test.ts` 案例併入 store 測試（行為驗收不變：pause/resume 切換、rescue override 優先序）。
2. **integration 擴充**（紅→綠）：adapter 增 `steer(agentId, message)`（fake service 測試）。
3. **`tools.ts`**（紅→綠）：每個 tool 的 `execute` 抽成可測純邏輯（`executeListTargets(deps, input)` 形式，deps 注入 store/registry/integration/config/now），unit tests 覆蓋：
   - list_targets 的 includeCompleted 過濾。
   - read_events 未知 id → 錯誤訊息。
   - detect_stuck 帶 suggestedRescueMessage。
   - alert_main：paused 抑制、cooldown 抑制、成功路徑呼叫 sink 並 recordAlert、sink 缺席錯誤。
   - steer：dry-run 預設、main_only 拒絕實際 steer、`alertMode: 'both'` + dryRun:false 實際呼叫 steer。
   - config get/set 白名單。
   - `formatAlert` 樣板快照測試。
4. **註冊接線**：`index.ts` 呼叫 `registerWatchdogTools(pi, deps)`；父 instance 註冊 alert sink。`pi.registerTool` 簽名以 dist 型別為準。
5. **驗證**：type-check + 全部測試綠（既有 74 不回歸，state 測試轉移後總數不減）；`pi -e` smoke。

---

## 5. 驗收標準

- [ ] watchdog 子 session 可呼叫 `watchdog_detect_stuck` 取得 evidence + suggestedRescueMessage（unit test 以注入 deps 驗證；手動 E2E 留 Task06）。
- [ ] `watchdog_alert_main` 遵守 paused 與 cooldown；alert 文字符合 §8.2 樣板。
- [ ] `watchdog_steer_subagent` 預設 dry-run；`main_only` 模式拒絕實際 steer。
- [ ] type-check + 全部測試通過。

## 6. Revision History

| Version | Change |
|---|---|
| v1 | 初版：tools 跨 session 設計（alert sink / store 化 runtime 狀態）、6 tools 定義、TDD 步驟 |

## 7. Reference

- reference01: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task05 定義
- reference02: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` — §8.2, §9, §15
- reference03: https://pi.dev/docs/latest/extensions — registerTool / sendMessage（accessed 2026-07-08）
