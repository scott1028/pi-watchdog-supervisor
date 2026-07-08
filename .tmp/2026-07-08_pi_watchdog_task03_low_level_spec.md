# Task03 — 事件收集（子 session 自我回報 + 共享 store）：Low-Level Detail Spec

- Date: 2026-07-08
- Source: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task03）；requirement §7.1, §7.2, §10
- Status: v1 — 使用者已指示直接實作，本文件同步作為實作依據與追溯紀錄
- Perspective: TDD

---

## 1. Spike 結果（讀 `@gotgenes/pi-subagents@18.0.1` 原始碼，已完成）

`src/lifecycle/create-subagent-session.ts` 確認：

1. **子 session 在同一個 process 內執行**（in-process），且「children always load the parent's extensions」— `await session.bindExtensions({})` 會重跑我們的 extension factory，`session_start` 會在子 session 內觸發。
2. `subagents:child:session-created` `{ sessionId, parentSessionId }` 在 `bindExtensions()` **之前**同步發布於**父的 event bus** — 父端 instance 可在子端 extension 初始化前先登記該 child sessionId。
3. Agent record id（`randomUUID`，來自 subagent-manager）**≠** child sessionId，事件與 record 均無兩者對應 — 需自建關聯。
4. 每個 spawn 的 assembly 序列為 `spawning → session-created → bindExtensions → started`，同 process 同步發布。

### 架構簡化決策（偏離 high-level spec，理由如下）

共享 store 改用 **`globalThis` Symbol 註冊的 in-memory store**（仿 pi-subagents 自身的 `Symbol.for()` service 發布模式），**不用 JSONL 檔案**：

- Spike 證實父子 session 同 process → in-memory 天然共享、原子、零 I/O。
- 跨 process 場景（獨立 pi session 經 pi-intercom）本來就在 MVP 範圍外。
- 檔案格式、鎖、清理等複雜度全部消失。

---

## 2. 範圍

### In scope

- `src/normalize.ts`：`normalizeCommand()`、`hashOutput()`（requirement §7.2）。
- `src/store.ts`：globalThis 共享 store — child 登記、per-target ring buffer（`maxEventsPerAgent`）、agentId↔sessionId 關聯。
- `src/collector.ts`：子 session 端事件收集 — 監聽自身 `tool_call` / `tool_result`，萃取 commandKey / outputHash / edit 判定，寫入 store。
- `src/index.ts`：角色分流 — 判斷自己是 parent 或 child instance，child 走 collector、parent 維持 Task02 行為並登記 child sessionId 與 id 關聯。
- `/watchdog inspect <targetId>` 實作（取代 Task01 stub）：顯示該 target 最近的 compact 事件。

### Out of scope

- stuck 偵測（Task04）；`watchdog_read_events` 等 tools（Task05，本 Task 先以 `/watchdog inspect` 驗證資料流）。

---

## 3. 資料模型（requirement §10 子集）

```ts
// src/types.ts 新增
type WatchdogEventType =
  | 'subagent_created' | 'subagent_started' | 'subagent_completed' | 'subagent_failed'
  | 'tool_call' | 'tool_result' | 'edit';

type WatchdogEvent = {
  id: string;               // `${sessionId}-${seq}`
  targetId: string;         // child sessionId（store 主鍵）
  at: number;
  type: WatchdogEventType;
  summary: string;          // e.g. `bash: rg "TOKEN" src`
  commandKey?: string;      // normalized command（bash 類）或 toolName+主要參數
  outputHash?: string;
  outputPreview?: string;   // 前 maxPreviewLines 行
};
```

### 共享 store 契約

```ts
// src/store.ts — 發布於 Symbol.for('pi-watchdog-supervisor:store')
type WatchdogStore = {
  registerChild: (sessionId: string, parentSessionId?: string) => void;
  getChild: (sessionId: string) => { parentSessionId?: string } | undefined;
  linkAgent: (agentId: string, sessionId: string) => void;
  resolveTargetKey: (idOrSessionId: string) => string | undefined; // agentId 或 sessionId → sessionId
  appendEvent: (sessionId: string, event: Omit<WatchdogEvent, 'id' | 'targetId'>) => void;
  getEvents: (sessionId: string, limit?: number) => WatchdogEvent[];
};

// 任一 instance 先載入者建立；之後的 instance 取得同一份
const getOrCreateStore = (maxEventsPerAgent: number): WatchdogStore => { ... }
```

### agentId ↔ sessionId 關聯（heuristic，需標註於程式註解）

父端維護 FIFO：收到 `subagents:child:session-created` push sessionId；收到 `subagents:started { id }` 時 shift 最舊未關聯的 sessionId → `linkAgent(id, sessionId)`。同一 spawn 的兩事件在 assembly 序列中相鄰（spike 事實 4），佇列化併發時順序仍成立；此為 MVP heuristic，偏差時僅影響顯示關聯、不影響事件收集正確性。

---

## 4. 正規化規則（requirement §7.2）

```ts
// normalizeCommand(raw: string): string
strip ANSI escape codes → trim → collapse 連續空白為單一空格

// hashOutput(raw: string, opts: { maxBytes?: number; previewLines: number })
//   : { hash: string; preview: string }
strip ANSI → truncate 至 maxBytes（default 65536）→ sha256 hex
preview = 正規化後前 previewLines 行（maxPreviewLines config，default 20）
```

commandKey 萃取：`tool_call` 事件 args 中 `command`（bash 類）優先；否則 `toolName + ' ' + 主要字串參數（path/pattern 等，取第一個 string 值）`。edit 判定：toolName ∈ {edit, write, patch, multi_edit}（不分大小寫比對）→ 事件 type `'edit'`。

---

## 5. 實作步驟（TDD）

### Step 1 — `normalize.ts`（紅→綠）

`test/normalize.test.ts`：ANSI 移除、空白 collapse、trim；hash 對相同輸入穩定、不同輸入不同；truncate 生效；preview 行數上限；空字串輸入。

### Step 2 — `store.ts`（紅→綠）

`test/store.test.ts`：

1. `getOrCreateStore` 兩次呼叫回傳同一 instance（globalThis 共享）；測試間需清除 Symbol key。
2. `registerChild` / `getChild`。
3. `appendEvent` 自動編 seq id 與 targetId；超過 `maxEventsPerAgent` 時丟最舊（ring buffer）。
4. `getEvents(sessionId, limit)` 回傳最新 limit 筆（時序遞增）。
5. `linkAgent` + `resolveTargetKey`：agentId 與 sessionId 皆可解析；未知 id → undefined。
6. FIFO 關聯 helper（若獨立成函式）：session-created ×2 + started ×2 → 依序配對。

### Step 3 — `collector.ts`（紅→綠）

以 fake `pi`（`on(event, handler)` 記錄 handler、可手動觸發）測試：

1. `tool_call`（bash, `command: 'rg  "X"  src'`）→ store 出現 type `tool_call`、commandKey 正規化後的事件。
2. `tool_result` → 事件含 outputHash 與 preview。
3. `tool_call`（edit）→ type `'edit'`。
4. `tool_result` payload 非預期結構 → 不 throw、略過。

實作介面：`startCollector(pi, store, sessionId, config)` — 訂閱並寫入，回傳 unsubscribe。tool_call/tool_result 的實際 payload 欄位以 `@earendil-works/pi-coding-agent` 型別宣告為準（實作時查 `dist/*.d.ts`，於回報註明實際欄位名）。

### Step 4 — `index.ts` 角色分流 + parent 接線

```txt
factory 執行（父與子皆會跑）
  ├─ getOrCreateStore(config.maxEventsPerAgent)
  ├─ 訂閱 'subagents:child:session-created' → store.registerChild(...)   // 父端才收得到
  ├─ 訂閱 'subagents:started' → FIFO linkAgent                            // 父端
  ├─ Task02 既有：subagents:* → registry.applyEvent                       // 父端
  └─ session_start 時：sessionId = ctx.sessionManager.getSessionId()
       └─ if store.getChild(sessionId) → 本 instance 是 child → startCollector(...)
          （child instance 不需 registry/指令行為改變；registerCommand 在子 session 內無害）
```

- `ctx.sessionManager.getSessionId()` 的實際 API 以型別宣告為準；若無此方法，改用可取得 session 識別的等價 API 並回報。

### Step 5 — `/watchdog inspect <targetId>` + status 整合

- `inspect`：`store.resolveTargetKey(arg)` → `getEvents(key, 20)` → 每行 `HH:MM:SS type summary [hash 前 8 碼]`；未知 id → 提示。
- `status`：target 行尾追加 `events=<count>`（有 buffer 時）。

### Step 6 — 驗證

- `npm run type-check`、`npm test` 全綠（既有 32 tests 不得回歸）。
- Smoke：`pi -e ./src/index.ts` 載入無錯誤。

---

## 6. 驗收標準

- [ ] normalize / store / collector / FIFO 關聯 unit tests 全過。
- [ ] 手動場景（需 TUI + API key + pi-subagents）：spawn 一個 task sub-agent 執行數個 tool calls → 父 session `/watchdog inspect <id>` 顯示其 tool_call 事件（含 commandKey 與 output hash）。
- [ ] type-check + 全部測試通過，既有測試無回歸。

## 7. Revision History

| Version | Change |
|---|---|
| v1 | 初版：含 spike 結果、globalThis store 簡化決策、FIFO 關聯 heuristic、TDD 步驟 |

## 8. Reference

- reference01: `@gotgenes/pi-subagents@18.0.1` `src/lifecycle/create-subagent-session.ts`、`src/lifecycle/child-lifecycle.ts`、`src/lifecycle/subagent-manager.ts`（accessed 2026-07-08）
- reference02: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task03 定義
- reference03: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` — §7.1, §7.2, §10
