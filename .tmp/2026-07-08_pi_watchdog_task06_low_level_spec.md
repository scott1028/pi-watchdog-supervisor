# Task06 — Supervisor 工作流與文件：Low-Level Detail Spec

- Date: 2026-07-08
- Source: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md`（Task06）；requirement §8, §13, §14, §20, §21, §23
- Status: v1 — 使用者已指示直接實作
- 前置：Task01–05 已完成並 commit（`1069bf4`）
- 性質：以文件與 prompt 資產為主，程式變更僅 package.json manifest

---

## 1. 範圍

### In scope

| 產出 | 內容依據 |
|---|---|
| `prompts/watchdog-agent.md` | requirement §8.1 watchdog prompt + §8.2 alert 格式；工具名對齊 Task05 實作 |
| `skills/watchdog-supervisor/SKILL.md` | requirement §21 六步驟；格式以 pi 文件 / 現有套件的 SKILL.md 慣例為準（實作時查證，回報格式出處） |
| `examples/AGENTS.md` | requirement §20 main agent 指引 + Option A 輪詢說明（Option B 標註 post-MVP） |
| `examples/watchdog-supervisor.json` | requirement §11 範例 project config |
| `README.md` | 架構圖（三層分工 + 資料流）、安裝（`pi install` / `pi -e`）、指令表、tools 表、config 說明、手動 E2E 場景（§2） |
| `package.json` | pi manifest 增 `skills`；補 `description`、`keywords: ["pi-package"]` |

### Out of scope

- Option B（extension-driven tick）實作；pi-intercom 整合；npm 發布設定。

---

## 2. 手動 E2E 場景（README 收錄，依 requirement §23）

```txt
前置：已安裝 @gotgenes/pi-subagents；本 extension 以 pi -e ./src/index.ts 載入；有 API key。

1. main session 啟動 watchdog sub-agent：
   spawn 一個 subagent，prompt = prompts/watchdog-agent.md 內容 + 「supervise the task agents」
2. main session 啟動 dummy loop task sub-agent：
   prompt = 「Run `rg "SOME_TOKEN" src` three times, do not change the query or path,
   then run it two more times.」
3. 等 task agent 跑完幾次 rg 後，請 watchdog agent 檢查：
   對 watchdog steer/prompt：「Check task sub-agent status now.」
4. 預期：
   - watchdog 呼叫 watchdog_list_targets → 看到 task agent likelyStuck=true
   - watchdog 呼叫 watchdog_detect_stuck → evidence 含 repeated_command/repeated_output
   - watchdog 呼叫 watchdog_alert_main → main session 出現 [Watchdog Alert]
5. main agent 決策：可要求 watchdog 執行 watchdog_steer_subagent（預設 dry-run）；
   實際 steer 需先 watchdog_config set alertMode=both。
```

## 3. 內容要求

- prompt 與 skill 中的工具名、指令名必須與實作完全一致（`watchdog_list_targets` 等 6 個、`/watchdog` 6 個子指令）。
- README 架構圖用 ASCII（高階 spec §2.2 資料流圖可簡化沿用）。
- skill 步驟需含「ignore yourself and completed agents」「do not steer unless explicitly allowed」（requirement §21）。
- 文件用英文撰寫（開源 Pi package 慣例）；rescueMessage 預設值保留中文原文並附英文說明。
- README 註明：alert 的 cooldown / pause 行為、alertMode 安全預設、Option B 為 post-MVP。

## 4. 驗收標準

- [ ] 上表 6 項產出齊備；工具/指令名稱與程式碼一致（grep 對照）。
- [ ] `npm run type-check` + `npm test` 全綠（不應有程式邏輯變更）。
- [ ] `pi -e ./src/index.ts` smoke test 載入無錯誤（manifest 變更後）。
- [ ] SKILL.md 格式符合 pi 慣例（查證來源記錄於回報）。

## 5. Reference

- reference01: `.tmp/2026-07-08_pi_watchdog_extension_requirement.md` §8, §13, §14, §20, §21, §23
- reference02: `.tmp/2026-07-08_pi_watchdog_high_level_spec.md` — Task06 定義
- reference03: https://pi.dev/docs/latest/packages — skills 慣例（accessed 2026-07-08）
