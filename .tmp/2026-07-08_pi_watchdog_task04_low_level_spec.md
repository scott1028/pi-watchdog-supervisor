# Task04 — Stuck 偵測器：Low-Level Detail Spec

- Date: 2026-07-08
- Source: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task04）；requirement §7.3, §9.3, §15
- Status: v1 — 使用者已指示直接實作
- Perspective: TDD
- 前置：Task03 已完成（事件 buffer 以 child sessionId 為 key 存於共享 store）

---

## 1. 範圍

### In scope

- `src/detector.ts`：純函式偵測器 — 吃 `WatchdogEvent[]` + config + now，回傳 `StuckAnalysis`。
- 四種 evidence（requirement §9.3）：`repeated_command`、`repeated_output`、`typecheck_loop`、`idle_no_progress`。
- Cooldown + 同 evidence key 去重：狀態存於共享 store（Task05 的 tools 會從 watchdog 子 session 呼叫，必須跨 instance 共享）。
- `/watchdog status`：target 行追加 `STUCK?` 標記；`/watchdog inspect`：尾端附偵測分析摘要。

### Out of scope

- alert 發送與 rescue message 組裝（Task05）；watchdog_* tools（Task05）。

---

## 2. 資料模型

```ts
// src/types.ts 新增
type StuckEvidenceType =
  | 'repeated_command' | 'repeated_output' | 'idle_no_progress' | 'typecheck_loop';

type StuckEvidence = { type: StuckEvidenceType; summary: string };

type StuckAnalysis = {
  likelyStuck: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];          // 人讀得懂的一句話 per rule
  evidence: StuckEvidence[];
  evidenceKey: string;        // 去重 key：sorted evidence types + 觸發 hash/command 的 sha256 前 16 碼
};
```

### 共享 store 擴充（`src/store.ts`）

```ts
type WatchdogStore = {
  // ...Task03 既有...
  getLastAlert: (targetId: string) => { at: number; evidenceKey: string } | undefined;
  recordAlert: (targetId: string, evidenceKey: string, at: number) => void;
};
```

---

## 3. 偵測規則（分析範圍 = buffer 內全部事件，buffer 本身已由 `maxEventsPerAgent` 限幅）

### R1 `repeated_command` + R2 `repeated_output`

以 `tool_result` 事件分組 `commandKey`：
- 某 commandKey 出現次數 ≥ `repeatThreshold`（3）→ `repeated_command`。
- 且其中相同 `outputHash` 次數 ≥ `repeatThreshold` → 追加 `repeated_output`。
- 只看**最近的連續尾段**不強制 — MVP 以整個 buffer 計數（buffer 已限幅 200 筆）；若同 commandKey 之後出現過 `edit` 事件，該 commandKey 計數歸零重算（有進展就不算迴圈）。

### R3 `typecheck_loop`

commandKey 含 `tsc` / `type-check` / `typecheck`（不分大小寫、字邊界不要求）的 `tool_result`，相同 `outputHash` 出現 ≥ `typecheckRepeatThreshold`（2）→ `typecheck_loop`。同樣受「後續 edit 歸零」規則約束。

### R4 `idle_no_progress`

- buffer 內最後一筆事件距 `now` < 60s（tools 仍在動），且
- 最後一筆 `edit` 事件距 `now` ≥ `idleNoProgressSec`（300s）（或 buffer 內完全沒有 edit 且最早事件距 now ≥ idleNoProgressSec），且
- 期間內 `tool_call`/`tool_result` ≥ 5 筆（避免剛啟動誤報）。

### Confidence 對映（確定性）

```txt
evidence 種類數 0 → likelyStuck=false, confidence='low'
evidence 種類數 1 → likelyStuck=true,  confidence='medium'
evidence 種類數 ≥2 → likelyStuck=true, confidence='high'
```

### Cooldown 判定（`shouldAlert`）

```ts
// src/detector.ts
const shouldAlert = (
  lastAlert: { at: number; evidenceKey: string } | undefined,
  analysis: StuckAnalysis,
  now: number,
  cooldownSec: number,
): boolean
```

- `likelyStuck === false` → false。
- 無 lastAlert → true。
- `now - lastAlert.at < cooldownSec*1000` **且** `evidenceKey === lastAlert.evidenceKey` → false（同證據冷卻中）。
- evidenceKey 不同 → true（新證據不受冷卻限制）；冷卻期滿 → true。

---

## 4. 實作步驟（TDD）

### Step 1 — `detector.ts` 規則（紅→綠）

`test/detector.test.ts`（以 helper 建造事件序列）：

1. 同 commandKey 的 tool_result ×3（同 hash）→ `repeated_command` + `repeated_output`、confidence='high'、likelyStuck=true。
2. 同 commandKey ×3 但 hash 各異 → 只有 `repeated_command`、confidence='medium'。
3. 同 commandKey ×2 → 無 evidence、likelyStuck=false。
4. 同 commandKey ×3 但中間穿插 `edit` → 計數歸零 → 無 evidence。
5. `tsc` commandKey 同 hash ×2 → `typecheck_loop`。
6. 最後事件在 30s 內、無 edit ≥ 300s、tool 事件 ≥ 5 → `idle_no_progress`；tool 事件只有 3 筆 → 不觸發；最後事件距 now 120s（agent 已停）→ 不觸發。
7. `evidenceKey` 對相同輸入穩定、對不同 evidence 集合不同。
8. 空 buffer → likelyStuck=false。

### Step 2 — `shouldAlert`（紅→綠）

測試 §3 cooldown 判定的四個分支。

### Step 3 — store 擴充（紅→綠）

`getLastAlert` / `recordAlert` roundtrip；跨 `getOrCreateStore()` 呼叫共享。

### Step 4 — 指令整合

- `status`：對每個可解析出事件 buffer 的 target 跑 `detectStuck`，`likelyStuck` 時行尾加 ` !! likely stuck (<confidence>)`。
- `inspect`：事件列表之後追加 `analysis: likelyStuck=<bool> confidence=<c> reasons=[...]`。

### Step 5 — 驗證

`npm run type-check` + `npm test` 全綠（既有 56 tests 不得回歸）；`pi -e` smoke test。

---

## 5. 驗收標準

- [ ] 高階 spec 驗收：模擬同一 `rg` 指令重複 3 次（同輸出）→ `likelyStuck === true`、evidence 含 `repeated_command`（unit test 覆蓋）。
- [ ] cooldown：同 evidenceKey 於 `cooldownSec` 內 `shouldAlert` 回 false；新 evidenceKey 回 true（unit test 覆蓋）。
- [ ] type-check + 全部測試通過，無回歸。

## 6. Revision History

| Version | Change |
|---|---|
| v1 | 初版：四規則定義、edit 歸零原則、confidence 對映、cooldown 判定、TDD 步驟 |

## 7. Reference

- reference01: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task04 定義
- reference02: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` — §7.3, §9.3, §15
