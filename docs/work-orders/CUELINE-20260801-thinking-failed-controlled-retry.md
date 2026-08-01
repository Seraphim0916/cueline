# CUELINE-20260801：`Thinking failed` 受控重試

## 工單狀態

- 狀態：READY
- 優先級：P1（阻塞既有 GPT Pro controller run）
- 類型：engineering / controller recovery
- 建立者：`codex-s`
- 建立日期：2026-08-01 Asia/Taipei
- 目標 repo：`/Users/vincentw/dev/cueline`
- 真實驗證面：CueLine CLI + 內建 Browser + ChatGPT Pro

## 事故身分

- run：`run_e3e52e6445e39db8e20e46485e084651`
- round：`24`
- request：`msg_3a53c64ee7c85cf4045dcc91472920ba`
- conversation：`https://chatgpt.com/c/6a58682a-f1ec-83ee-a6f9-64298ea03d15`
- submitted event：sequence `528`，model=`Pro`，submissionState=`submitted`
- 畫面結果：`Thinking failed`
- normalized incident evidence SHA-256：`1428ba68fdff81b81ab2ee4025b53b2f9b9aa620a064341921bdffb04635d75d`
- durable 現況：`controller_response_pending`、`pendingTurns=1`、`responseAccepted=false`

## 問題

CueLine 0.7.3 只辨識：

- code：`CHATGPT_MESSAGE_DELIVERY_TIMEOUT`
- message：`Message delivery timed out. Please try again.`

ChatGPT Pro 顯示 `Thinking failed` 時，CueLine 沒有建立 controller failure evidence，run 永久停在 `controller_response_pending`。頁面沒有可安全鎖定的 `Retry`／`Regenerate` 控制，現行 delivery-timeout Retry 也不接受此狀態。

直接手動重送不合格：原使用者 turn 已存在，可能造成同一 Gate 重複執行。

## 目標行為

加入 `Thinking failed` 的身分綁定、一次性、可恢復 controller retry：

1. 唯讀觀測 exact conversation 的 current submitted turn。
2. 僅在 exact `run_id`、`round`、`request_id`、Pro model、`Thinking failed` 相符時記錄 failure。
3. 將 run 轉為明確 failure phase；不得繼續假裝 `controller_response_pending`。
4. 產生穩定 evidence hash，狀態顯示 exact operator approval requirement。
5. 未核准前零 click、零 composer mutation、零 resend。
6. 核准後再次確認：
   - conversation URL 未變；
   - current request failure 仍存在；
   - Pro 已停止回答；
   - composer 空白、零附件；
   - 沒有相同或較新 controller response／command；
   - 沒有 cancellation、active owner 或其他 pending controller turn。
7. 若存在可精確歸屬 current failed turn 的 Retry 控制，只 click 一次。
8. 若沒有 Retry 控制，先 durable abandon failed transport attempt，再由 persisted prompt 建立一次新 transport request：
   - 產品 round 維持 `24`；
   - 新 request ID；
   - `retry_of_request_id=msg_3a53c64ee7c85cf4045dcc91472920ba`；
   - transport attempt 加一；
   - 最多一次。
9. authorization 必須在任何 click／composer mutation 前 durable consumed。程序中斷後不得再次自動送。
10. target、DOM、model、composer 或 identity 改變時記錄 `retry_skipped`，零送出。

## 硬性安全條件

- 禁止 automatic retry。
- 禁止重送到其他 conversation。
- 禁止重跑已接受的 controller command。
- 禁止用訊息數量單獨判定 current turn。
- 禁止 click 歷史 assistant 的 regenerate。
- 禁止按 `Answer now`、`Respond now`、`Stop`。
- 禁止修改 `events.jsonl` 人工造狀態。
- 禁止碰 `/Users/vincentw/dev/fubon-autotrade` 程式、SHADOW、安全、交易、憑證、provider 或 scheduler。
- 禁止 deploy、release、npm publish、commit、push，除非另行核准。

## 建議狀態與事件

命名可依既有架構調整，但語意必須獨立且不可冒充 delivery timeout：

- failure code：`CHATGPT_THINKING_FAILED`
- phase：`controller_response_failed`
- safe next action：`authorize_controller_response_retry`
- authorization event：`controller_response_retry_authorized`
- consumed event：`controller_response_retry_authorization_consumed`
- action event：`controller_response_retry_invoked` 或 `controller_response_retry_resent`
- no-op event：`controller_response_retry_skipped`

## 預期修改面

先以 codebase-memory 確認實際 call graph，再鎖 exact files。候選範圍：

- `src/browser/codex-iab/bootstrap.ts`
- `src/browser/codex-iab/chatgpt-client.ts`
- `src/browser/browser-adapter.ts`
- `src/core/controller-loop.ts`
- `src/core/state-machine.ts`
- `src/core/run-status.ts`
- `src/api-controller-handoff.ts`
- `src/cli/main.ts`
- `skills/cueline/SKILL.md`
- 直接對應 unit / integration / browser mock tests

不得因方便而把所有 provider error 都歸成可重試；本工單只處理 exact `Thinking failed`。

## 紅燈測試（實作前）

至少新增並先證明失敗：

1. current submitted turn 顯示 `Thinking failed` 時，read-only observation 回傳 exact failure evidence。
2. 歷史 turn 含 `Thinking failed` 不得命中 current request。
3. model 非 Pro、URL 不符、request 不符、仍在回答時不得命中。
4. failure 被 durable 記錄後，run status 不再是 `controller_response_pending`。
5. 未授權、授權不符、授權已消耗時皆零送出。
6. 沒有 Retry 控制時，受控 resend 僅一次，same round + new request ID + retry linkage。
7. crash 發生於 authorization consumed 後、send 前／後，restart 不得重複送。
8. target 在 pre-inspect 與 action 間改變時 `retry_skipped`。
9. DOM 虛擬化與訊息數倒退不得造成誤收或誤送。
10. round 1 舊 delivery-timeout authorization 不得套用 round 24。

## 驗證矩陣

### 離線

- `npm run typecheck`
- exact new unit tests
- exact new integration tests
- existing delivery-timeout recovery tests
- full `npm test`
- `npm run release:check` 僅檢查，不發布

### 真實 Browser

1. 使用隔離 canary conversation 製造／fixture 注入 `Thinking failed` 狀態。
2. 驗證未授權時零送出。
3. 核准 exact evidence 後只產生一次 retry。
4. 驗證完成 envelope 的 run/round/request/retry linkage。
5. 驗證 reload、observer restart 後不重複送。

### 原事故 run

所有離線與 canary 驗證通過後，另取得 round 24 exact approval，才對本工單事故身分執行一次恢復。成功標準：

- round 24 GPT Pro response envelope 被 CueLine durable 接收；
- pending turn 歸零；
- 不新增第二個未關聯 turn；
- Q3-a run 可進下一個 Gate；
- 沒有任何 Fubon runtime mutation。

## 核准文字模板

> 我核准 CueLine 對 run `run_e3e52e6445e39db8e20e46485e084651`、round `24`、request `msg_3a53c64ee7c85cf4045dcc91472920ba`、conversation `https://chatgpt.com/c/6a58682a-f1ec-83ee-a6f9-64298ea03d15` 的 exact `Thinking failed` evidence，在修補完成且離線／canary 驗證全數通過後執行一次受控 retry；禁止自動重試、其他 conversation、其他 round/request、歷史 regenerate、Fubon mutation、deploy、release、commit、push。任何 identity 或 guard 不符即跳過。

## 回滾要求

1. 修改前建立 repo 外不可覆寫備份，含 manifest、SHA-256、restore commands。
2. 不覆蓋既有 working-tree 變更。
3. 回滾後重新執行 typecheck、relevant tests、full tests。
4. 真實 Browser 若進入不明狀態，保留 durable evidence，停止 retry；不得猜測送出結果。

## 完成定義

只有以下全數成立才能標 PASS：

- 紅燈測試先失敗、修補後轉綠；
- typecheck、targeted、full tests 通過；
- Browser canary 真實驗證通過；
- exact run 受控恢復一次且 envelope durable accepted；
- restart／reload 後零重送；
- changelog 記錄完整；
- Fubon Q3-a 能從同一 run 繼續。

測試全綠但未完成 Browser 與 exact run 驗證，只能標 `PARTIAL`。
