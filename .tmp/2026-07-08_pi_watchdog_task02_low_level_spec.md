# Task02 — Sub-agent 發現與生命週期追蹤：Low-Level Detail Spec

- Date: 2026-07-08
- Source: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task02）；requirement §9.1, §10, §12.1
- Status: v1 — 使用者已指示直接實作，本文件同步作為實作依據與追溯紀錄
- Perspective: TDD

---

## 1. Spike 結果（讀 `@gotgenes/pi-subagents@18.0.1` 原始碼，已完成）

`src/service/service.ts` 確認：

```ts
// 同步 accessor，service 發布於 globalThis Symbol.for("@gotgenes/pi-subagents:service")
getSubagentsService(): SubagentsService | undefined

interface SubagentsService {
  spawn(type: string, prompt: string, options?: SpawnOptions): string;
  getRecord(id: string): SubagentRecord | undefined;
  listAgents(): SubagentRecord[];          // 最新在前
  abort(id: string): boolean;
  steer(id: string, message: string): Promise<boolean>;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
}

interface SubagentRecord {
  id: string; type: string; description: string;
  status: SubagentStatus;                  // queued|running|completed|steered|aborted|stopped|error
  result?: string; error?: string;
  toolUses: number; startedAt: number; completedAt?: number;
  lifetimeUsage: LifetimeUsage; compactionCount: number;
}
```

`src/observation/subagent-events-observer.ts` 確認事件 payload：

| Channel | Payload |
|---|---|
| `subagents:created` | `{ id, type, description, isBackground: true }` |
| `subagents:started` | `{ id, type, description }` |
| `subagents:completed` / `subagents:failed` | `buildEventData(record)`（含 id；failed = status ∈ error/stopped/aborted） |
| `subagents:steered` | `{ id, message }` |
| `subagents:compacted` | `{ id, type, description, reason, tokensBefore, compactionCount }` |

另確認（Task03 可用，本 Task 不用）：`subagents:child:session-created` payload 為 `{ sessionId, parentSessionId? }` — parent id 取得方式已解。

**重要推論**：`listAgents()` 已提供 status/toolUses/lastActive 基礎資料 → Task02 採「事件驅動 + 指令時 `listAgents()` 對帳」雙軌，不需自建完整狀態機。

---

## 2. 範圍

### In scope

- `src/integrations/gotgenes-subagents.ts`：optional 整合 adapter（dynamic import + try/catch；未安裝時回傳 unavailable）。
- `src/registry.ts`：target registry — 從 `SubagentRecord` 映射為 `WatchdogTarget`，事件更新 `lastActiveAt`。
- kind 分類：`type` 或 `description` 含 `watchdog`（不分大小寫）→ `'watchdog'`，否則 `'task'`；無法判斷 → `'unknown'`。
- `/watchdog status` 改為列出 targets（id、name/description、kind、status、toolUses、lastActiveAt）；service 缺席時顯示 `subagent service unavailable (install @gotgenes/pi-subagents)`。
- `@gotgenes/pi-subagents` 列為 optional peerDependency + devDependency（開發/驗收用）。

### Out of scope

- tool_call 級事件收集、共享 store（Task03）；stuck 偵測（Task04）；watchdog tools（Task05）。

---

## 3. 資料模型

```ts
// src/types.ts 新增
type TargetKind = 'task' | 'watchdog' | 'unknown';

type WatchdogTarget = {
  id: string;
  name?: string;              // record.description
  kind: TargetKind;
  status: 'queued' | 'running' | 'completed' | 'steered' | 'aborted' | 'stopped' | 'error';
  toolCallCount: number;      // record.toolUses
  createdAt: number;          // record.startedAt
  lastActiveAt: number;       // 事件時間戳更新；初始 = startedAt
};
```

映射規則 `toWatchdogTarget(record, now)` 為純函式，事件套用 `applyEvent(targets, channel, payload, now)` 亦為純函式（I/O 分離）。

---

## 4. 實作步驟（TDD）

### Step 1 — registry 純函式（紅→綠）

`test/registry.test.ts` 失敗測試：

1. `classifyKind`：type 含 watchdog → `'watchdog'`；description 含 Watchdog → `'watchdog'`；一般 type → `'task'`。
2. `toWatchdogTarget`：欄位映射正確（toolUses→toolCallCount、startedAt→createdAt/lastActiveAt）。
3. `applyEvent`：`subagents:started` 更新既有 target 的 status 與 lastActiveAt；未知 id 時建立 minimal target；`subagents:failed` → status 依 payload；payload 缺 id → 不變。
4. `syncFromRecords`：以 `listAgents()` 結果對帳 — 新 record 加入、既有 target 保留較新的 lastActiveAt。

實作 `src/registry.ts` 使通過。

### Step 2 — 整合 adapter

`src/integrations/gotgenes-subagents.ts`：

```ts
type SubagentsIntegration =
  | { available: true; listAgents: () => SubagentRecordLike[]; }
  | { available: false; reason: string };

// dynamic import in try/catch; getSubagentsService() 回 undefined 也算 unavailable
const connectSubagents = async (): Promise<SubagentsIntegration> => { ... }
```

- 型別以本地最小結構型別（`SubagentRecordLike`）宣告，不直接 import 套件型別到核心模組 — adapter 隔離（高階 spec 風險緩解）。
- 事件訂閱：以 `pi.events.on(channel, handler)` 訂閱 §1 表列 6 個 channel（實作時以 `@earendil-works/pi-coding-agent` 型別宣告為準；若 API 名稱不同，於回報中註明實際名稱）。
- 測試：unavailable 分支（import 失敗 / service undefined）回傳 reason；available 分支以 fake globalThis service 測試。

### Step 3 — 接線 `index.ts` + `/watchdog status`

- `index.ts`：載入時 `connectSubagents()`，建立 registry，訂閱事件 → `applyEvent`。
- `commands.ts` `status`：先 `syncFromRecords(listAgents())` 對帳，再輸出：

```txt
watchdog-supervisor loaded | enabled=true | paused=false
targets (3):
  [task]      a1b2c3  running    tools=12  "explore campaign-list"
  [task]      d4e5f6  running    tools=3   "fix type errors"
  [watchdog]  g7h8i9  running    tools=1   "supervise task agents"
```

- service 缺席：`targets: unavailable — install @gotgenes/pi-subagents`。

### Step 4 — 驗證

- `npm run type-check`、`npm test` 全綠（既有 14 tests 不得回歸）。
- Smoke：`pi -e ./src/index.ts` 載入無錯誤（未裝 pi-subagents 時顯示降級訊息）。

---

## 5. 驗收標準

- [ ] `classifyKind` / `toWatchdogTarget` / `applyEvent` / `syncFromRecords` unit tests 通過。
- [ ] 未安裝（或 service 未發布）時 extension 正常載入，`/watchdog status` 顯示 unavailable 訊息。
- [ ] 安裝 pi-subagents 後：main session 有 2 task + 1 watchdog sub-agent 時 `/watchdog status` 正確列出 3 個 target 的 kind 與 status（手動場景，需 pi TUI）。
- [ ] type-check + 全部測試通過。

## 6. Revision History

| Version | Change |
|---|---|
| v1 | 初版：含 spike 結果（service 簽名、事件 payload、parent id 解法）與 TDD 步驟 |

## 7. Reference

- reference01: `@gotgenes/pi-subagents@18.0.1` npm tarball `src/service/service.ts`、`src/observation/subagent-events-observer.ts`、`src/lifecycle/{subagent-state,child-lifecycle}.ts`（accessed 2026-07-08）
- reference02: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task02 定義
