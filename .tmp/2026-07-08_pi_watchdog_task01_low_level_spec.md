# Task01 — Extension Skeleton 與設定系統：Low-Level Detail Spec

- Date: 2026-07-08
- Target reader: coding agent / implementation engineer
- Source:
  - High-level spec: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task01）
  - Requirement: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md`（§7.3, §10, §11, §16, §17 Milestone 1, §19）
- Status: v1 — ready for user review
- Perspective: TDD（先寫失敗測試，再實作使其通過）

---

## 1. 範圍

### In scope

- `pi-watchdog-supervisor` package 骨架（pi manifest、TypeScript、測試環境）。
- `WatchdogConfig` 型別、預設值、global + project config 載入與合併（project 覆蓋 global）。
- Session 層級的 runtime 狀態：`paused` 旗標、session-only `rescueMessage` 覆寫。
- 指令註冊：`/watchdog status`、`/watchdog config`、`/watchdog set rescueMessage <msg>`、`/watchdog pause`、`/watchdog resume`、`/watchdog inspect <targetId>`（stub）。

### Out of scope（後續 Task）

- sub-agent 發現（Task02）、事件收集（Task03）、stuck 偵測（Task04）、watchdog tools（Task05）。
- `/watchdog inspect` 只回覆「尚未實作，Task03 提供」的 stub 訊息。

---

## 2. 實作輸入（已查證的 API 事實）

- Extension 進入點：default export factory，`export default function (pi: ExtensionAPI) { ... }`，可為 async。型別來自 `@earendil-works/pi-coding-agent`。
- 開發載入：`pi -e ./src/index.ts`；extension 經 jiti 載入，TypeScript **免編譯**、可直接用 Node built-ins 與本地 npm 依賴。
- 指令註冊：`pi.registerCommand(name, { description, handler: async (args: string, ctx: ExtensionCommandContext) => void })`。
- 使用者輸出：`ctx.ui.notify(msg, "info" | ...)` 一行通知；互動前先檢查 `ctx.hasUI`（print/rpc 模式無 UI）。
- Package manifest：`package.json` 的 `pi` key，`{ "extensions": ["./src/index.ts"] }`；`keywords: ["pi-package"]` 供 gallery 曝光。
- Config 路徑（依需求文件 §11）：
  - Global: `~/.pi/agent/watchdog-supervisor/config.json`
  - Project: `.pi/watchdog-supervisor.json`

---

## 3. 檔案結構（本 Task 建立）

```txt
./                                  # repo root = package root
├─ package.json                     # pi manifest + scripts
├─ tsconfig.json
├─ vitest.config.ts
├─ src/
│  ├─ index.ts                      # extension entry: 載入 config、註冊 commands
│  ├─ types.ts                      # WatchdogConfig 等型別
│  ├─ config.ts                     # DEFAULT_CONFIG、loadConfigFile、mergeConfig、getConfigPaths
│  ├─ state.ts                      # SessionState: paused / rescueMessage 覆寫
│  └─ commands.ts                   # registerWatchdogCommands(pi, store)
└─ test/
   ├─ config.test.ts
   └─ state.test.ts
```

註：`detector.ts`、`events.ts`、`tools.ts`、`integrations/` 於後續 Task 依需求文件 §18 補齊。

---

## 4. 資料模型（本 Task 實作部分）

```ts
// src/types.ts
type WatchdogConfig = {
  enabled: boolean;              // default: true
  rescueMessage: string;         // default: 需求文件 §2.2 中文預設訊息
  repeatThreshold: number;       // default: 3
  typecheckRepeatThreshold: number; // default: 2
  idleNoProgressSec: number;     // default: 300
  cooldownSec: number;           // default: 60
  maxPreviewLines: number;       // default: 20
  maxEventsPerAgent: number;     // default: 200
  alertMode: 'main_only' | 'direct_subagent' | 'both'; // default: 'main_only'
};

// src/state.ts — session runtime 狀態（不落地）
type SessionState = {
  paused: boolean;                     // default: false
  rescueMessageOverride?: string;      // /watchdog set rescueMessage 設定
};
```

有效設定 = `DEFAULT_CONFIG ← global config ← project config ← session override`（右邊優先）。

---

## 5. 實作步驟（TDD）

每步驟：先寫測試（紅）→ 實作（綠）→ 驗證指令。

### Step 1 — Package 骨架與工具鏈

- 建立 `package.json`：`"type": "module"`、`pi.extensions: ["./src/index.ts"]`、`keywords: ["pi-package"]`；devDependencies：`typescript`、`vitest`、`@earendil-works/pi-coding-agent`（型別用）；scripts：`"test": "vitest run"`、`"type-check": "tsc --noEmit"`。
- 建立 `tsconfig.json`（ESM、strict）、`vitest.config.ts`。
- 驗證：`npm install` 成功；`npm run type-check` 通過；`npm test` 可執行（0 test files 亦可）。

### Step 2 — `types.ts` + `DEFAULT_CONFIG`

- 先寫 `test/config.test.ts` 失敗測試：
  - `DEFAULT_CONFIG` 各欄位值符合 §4（repeatThreshold=3、idleNoProgressSec=300、alertMode='main_only'、rescueMessage 為預設中文訊息…）。
- 實作 `src/types.ts` 與 `src/config.ts` 的 `DEFAULT_CONFIG` 使測試通過。

### Step 3 — Config 載入與合併

- 先寫失敗測試（`test/config.test.ts`，用 temp dir 產生假 config 檔）：
  1. 無任何 config 檔 → 回傳 `DEFAULT_CONFIG`。
  2. 僅 global → default 被 global 覆蓋，未指定欄位保留 default。
  3. global + project → project 欄位覆蓋 global，兩者未指定欄位保留 default。
  4. config 檔為無效 JSON → 忽略該檔並回傳 warning 訊息（不 throw、不中斷載入）。
  5. config 含未知欄位 → 忽略未知欄位。
  6. `getConfigPaths(projectDir)` 回傳正確 global/project 路徑（global 以 `os.homedir()` 展開）。
- 實作 `src/config.ts`：
  - `getConfigPaths(projectDir: string): { globalPath: string; projectPath: string }`
  - `loadConfigFile(path: string): { config: Partial<WatchdogConfig> | null; warning?: string }`（檔案不存在 → `null`，無 warning）
  - `mergeConfig(...parts: Array<Partial<WatchdogConfig> | null | undefined>): WatchdogConfig`
  - `loadEffectiveConfig(projectDir: string): { config: WatchdogConfig; warnings: string[] }`
- 設計約束：`loadConfigFile` / `mergeConfig` 為純函式（I/O 與合併分離），方便測試；不做 file watch，config 於 extension 載入時讀一次（`/reload` 可重讀）。

### Step 4 — Session 狀態

- 先寫失敗測試（`test/state.test.ts`）：
  1. 初始 `paused === false`、無 override。
  2. `pause()` / `resume()` 切換 `paused`。
  3. `setRescueMessage(msg)` 後 `getEffectiveRescueMessage(config)` 回傳 override；未設定時回傳 `config.rescueMessage`。
- 實作 `src/state.ts`（簡單 in-memory store，供 commands 與後續 Task 共用）。

### Step 5 — 指令註冊與 entry point

- 實作 `src/commands.ts` 的 `registerWatchdogCommands(pi, store)`：

| 指令 | 行為 |
|---|---|
| `/watchdog status` | 顯示：extension 版本、`enabled`、`paused`、config 摘要、target 數（Task01 固定顯示 `targets: 0 (subagent discovery: Task02)`） |
| `/watchdog config` | 顯示有效 config 全文（JSON pretty print）+ 各值來源不需標註（post-MVP） |
| `/watchdog set rescueMessage <msg>` | 設定 session override；`<msg>` 為空 → 顯示用法提示 |
| `/watchdog pause` | `paused = true`，通知使用者 |
| `/watchdog resume` | `paused = false`，通知使用者 |
| `/watchdog inspect <id>` | 回覆 stub：`inspect not implemented yet (Task03)` |

- 指令採單一 `/watchdog` 入口 + 子指令解析（`args.trim().split(/\s+/)`），未知子指令 → 顯示可用子指令清單。
- 輸出方式：`ctx.ui.notify()`（單行）；config 全文等多行內容在 `ctx.hasUI` 時用 notify 逐段或 `ctx.ui.custom`，無 UI 模式（print/rpc）改 `console.log`。以最簡可行為準，不做花式 TUI。
- 實作 `src/index.ts`：

```ts
export default function watchdogSupervisor(pi: ExtensionAPI) {
  // load config once at startup; surface warnings via notify on session_start
  // create session state store
  // registerWatchdogCommands(pi, store)
}
```

- config warning（如無效 JSON）在 `session_start` 時以 `ctx.ui.notify(warning, "warning")` 顯示一次。

### Step 6 — 手動驗收

依 §7 驗證指令逐項執行。

---

## 6. 測試覆蓋清單

| 測試 | 檔案 | 類型 |
|---|---|---|
| DEFAULT_CONFIG 欄位與預設值 | test/config.test.ts | unit |
| 無 config 檔 → defaults | test/config.test.ts | unit |
| global 覆蓋 default | test/config.test.ts | unit |
| project 覆蓋 global（部分欄位） | test/config.test.ts | unit |
| 無效 JSON → warning、不 throw | test/config.test.ts | unit |
| 未知欄位被忽略 | test/config.test.ts | unit |
| getConfigPaths 路徑正確 | test/config.test.ts | unit |
| pause/resume 切換 | test/state.test.ts | unit |
| rescueMessage override 優先序 | test/state.test.ts | unit |
| 指令行為（status/config/set/pause/resume/inspect） | 手動（§7） | manual |

註：commands 與 pi API 的互動層薄、依賴 `ExtensionAPI` runtime，MVP 以手動驗收為主，不為其建 mock harness（避免單次使用的測試設施；若後續 Task 需要再引入）。

---

## 7. 驗收標準與驗證指令

全部通過才算完成（依 completion verification 規則）：

```bash
npm run type-check        # tsc --noEmit 無錯誤
npm test                  # vitest run 全綠
```

手動場景（在本 repo 內執行）：

```txt
1. pi -e ./src/index.ts
2. /watchdog status
   → 顯示 extension 已載入、enabled=true、paused=false、targets: 0
3. /watchdog config
   → 顯示 DEFAULT_CONFIG 全文
4. 建立 .pi/watchdog-supervisor.json（如 {"repeatThreshold": 5}）→ /reload → /watchdog config
   → repeatThreshold 顯示 5，其餘為 default
5. /watchdog set rescueMessage 測試訊息
   → /watchdog status 或 config 反映 session override
6. /watchdog pause → status 顯示 paused=true；/watchdog resume → paused=false
7. /watchdog inspect xyz
   → 顯示 Task03 stub 訊息
8. 將 .pi/watchdog-supervisor.json 改為無效 JSON → /reload
   → extension 仍載入，顯示 warning，config 回退 default+global
```

---

## 8. 風險與注意事項

- `ExtensionCommandContext` 的 UI 細節（notify 多行支援、custom component 簽名）以實際型別定義為準；若與本 spec 假設不符，以「最簡輸出」原則調整，不影響驗收條件。
- `/reload` 是否重新執行 extension factory（重讀 config）需在 Step 6 實測確認；若否，改於 `session_start` 重讀。
- 依 karpathy 原則：不做 config file watch、不做來源標註、不做多語系輸出 — 未被要求的功能一律不加。

---

## 9. Revision History

| Version | Change |
|---|---|
| v1 | 初版：TDD 步驟、config 合併規則、指令表、測試清單與手動驗收場景 |

---

## 10. Reference

- reference01: https://pi.dev/docs/latest/extensions — entry point、registerCommand、ctx.ui、jiti 載入、`pi -e`（accessed 2026-07-08）
- reference02: https://pi.dev/docs/latest/packages — pi manifest、config/settings 路徑、local dev workflow（accessed 2026-07-08）
- reference03: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task01 定義
- reference04: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` — §7.3, §10, §11, §16, §19
