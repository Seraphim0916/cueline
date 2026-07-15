<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cueline-banner-dark.svg">
  <img alt="CueLine — ChatGPT 下指令，你的機器執行。" src="docs/assets/cueline-banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>繁體中文</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

**CueLine 把方向盤交給一個已經開著的 ChatGPT 網頁對話：由它規劃整趟執行、喊出每一步；CueLine 檢查每一道文字指令，現在這個 Codex 才在本機執行獲准的工作。**

那個網頁碰不到你的機器，也沒有本機工具。它每一輪只吐出文字控制指令。CueLine 預設把 caller 工作保存成待辦：`advise` 是協調式交接；`work` 則必須先建立持久 claim 並正式 start，才能開始修改。只有雙重明確授權 `process` executor 時，才會啟動已註冊的本機工作行程。

CueLine 是獨立實作，**沒有任何 runtime npm 相依套件**，也不是 Omnilane 或 GPT Relay 的包裝層。

## 最新版本：0.1.6

- 新增 caller `work` 的持久 claim／start／heartbeat／result fencing；開始前可安全回收，可能已有副作用時一律收斂為 `ambiguous`。
- 修正隱藏 `Stop answering` 誤判、inspect 指定輸出優先、stale 唯讀觀測恢復、process 雙重授權與 process 狀態可觀測性。
- 內建 process route 加上 `--ignore-user-config`，並防止後續不受信任輸出偽造 model/provider 狀態。
- 完成 267/267 測試、乾淨套件安裝，以及全新真實 ChatGPT Web Pro run 的終態 `complete` 驗收；無重送、無中斷。

完整內容請看 [changelog](CHANGELOG.md#016---2026-07-15) 或不可變的 [v0.1.6 release](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6)。

## 一次執行實際上怎麼跑

<img alt="Caller-first CueLine 執行：ChatGPT 下文字命令，目前的 Codex 做本機唯讀查驗，CueLine 回送有界證據直到 complete。" src="docs/assets/cueline-loop-zh-TW.svg" width="100%">

每一輪：CueLine 先把自己「即將問什麼」寫進紀錄，送出一份觀測（observation）到對話裡，之後再讀回**恰好一個** `<CueLineControl>` 封包。主控端從五個動作裡挑一個——`dispatch`、`wait`、`inspect`、`complete`、`blocked`——封包以外的任何文字都不會被執行。指令若寫錯 run、寫錯輪次，或工作定義有問題，會被退回去做有次數上限的修正，而不是靠猜。迴圈會在單次可靠送出後以 `awaiting_controller` 暫停，也會停在 caller 交接、`complete`、`blocked` 或輪數用完（預設 12 輪）。

非預設的 `maxRounds` 會在建立 run 時固定，並跨所有無 owner 的暫停累計主控總輪數。之後續跑通常省略它、沿用持久值；若傳入不同數字，CueLine 會拒絕，不會偷偷重設或放寬預算。

`startCueLineRun` 與 `runCueLine` 都預設使用 `caller` executor。使用內建瀏覽器時，CueLine 只送一次、保存精確對話 URL，然後回傳 `awaiting_controller` 並釋放 runtime lease，不會讓單一工具呼叫卡著等 Pro 思考。之後的 `continueCueLineRun` 只做一次唯讀觀測；若仍未完成，就再次回傳 `awaiting_controller`，絕不重送。`advise` 派工回傳 `awaiting_caller`，沒有副作用 claim，需協調單一 session。`work` 派工回傳 `awaiting_caller_work`，在目前 Codex 呼叫 `claimCueLineCallerJob` 與 `startCueLineCallerJob` 前，絕對尚未開始本機修改。claim 綁定 run、job、task hash、絕對 workdir、caller identity 與 fencing token；已開始的工作不會自動重試，claim 逾期則成為 `ambiguous`。Pro 只提出與審查文字指令，沒有親自使用本機工具。

Process 模式必須同時指定 `executor: "process"` 與 `allowProcessExecution: true`，非終態續跑也要再次傳入第二道授權。內建 route 另加 `--ignore-user-config`，不讓隱藏 worker 載入使用者設定的 MCP server 或其命令參數。通道（lane）必須啟用、候選項必須在任何程序啟動**之前**就確認可用、`argv[0]` 必須早已由路由設定註冊。沒有任何東西會經過 shell。唯讀工作預設全域與每 lane 最多同時 2 個；只要批次包含 `work` 就維持串行。狀態會顯示解析後 runner、PID、phase、最後進度時間，以及安全辨識到的 model/provider。

主控協定刻意區分路由層級：`lane` 填的是通道名稱 `default`；`codex-default` 是該通道內的候選執行器，不是通道。CueLine 會在註冊任何工作前先驗證整份 `dispatch`；只要包含無效通道或執行器，整份派工就會被退回修正，不會先執行其中一部分。

這是允許清單（allow-list），不是沙箱。已註冊的工作行程擁有跟 CueLine 行程本身相同的權限；`advise` 對應 Codex 的唯讀沙箱、`work` 對應 `workspace-write`，但你註冊了什麼，就等於你授權了什麼。

## 主控端必須是 Pro 模型

除非輸入框的模型選單顯示 `Pro`，否則 CueLine 拒絕送出。對話若停在別的模型，CueLine 會先把輸入框切成 `Pro`——這是它唯一被允許做的模型切換。在一次已驗證的實機執行中，它把 Instant 切成 Pro，回應回來的是 `gpt-5-6-pro`。

選了不等於證明了。每次回應之後，CueLine 會讀取該則已完成助理訊息的模型 slug，並要求它是 Pro 的 slug；送出與回覆之間若被降級，會被抓出來，而不是被信任。失敗會以 `MODEL_SELECTOR_MISSING`、`PRO_MODEL_UNAVAILABLE`、`PRO_MODEL_SELECTION_FAILED` 或 `PRO_MODEL_MISMATCH` 浮現——絕不會變成一個被接受的答案。

ChatGPT Pro 訂閱方案與「選定的 Pro 模型」是兩回事。帳號或個人資料標籤上出現 `Pro`，只是訂閱方案的證據，永遠不算模型證據；只有回應的模型 slug 才算。每一輪實機回合都會保存 `controller_response_received`，帶著 `selected_model_label`、`response_model_slug` 與 `model_evidence_source`，因此「是哪一種證據證明了模型」事後仍可稽核。

## 五分鐘上手

你需要 Node.js 22 以上、帶內建瀏覽器的 Codex，以及——若要用內建的預設通道——`PATH` 上有 `codex` CLI。

從 npm registry 安裝：

```bash
npm install -g cueline@0.1.6
cueline install
cueline doctor
```

作為備援，也可以安裝 [v0.1.6 release](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6) 上的打包 tarball，該 release 同時附上它的 `.sha256` 校驗碼：

```bash
npm install -g https://github.com/Seraphim0916/cueline/releases/download/v0.1.6/cueline-0.1.6.tgz
cueline install
cueline doctor
```

`cueline install` 只建立一個符號連結：把內建的 skill 接到 `$CODEX_HOME/skills/cueline`（預設 `~/.codex/skills/cueline`）。它拒絕覆寫不屬於自己的路徑，重複執行也不會有副作用。`cueline uninstall` 只移除那一個連結；若該位置換成了別人的檔案，它會保留而不刪除。

### 從原始碼安裝

```bash
git clone https://github.com/Seraphim0916/cueline.git
cd cueline
npm ci
npm run build
./install.sh      # 建立 ~/.codex/skills/cueline 與 ~/.local/bin/cueline 兩個符號連結
cueline doctor
```

`install.sh` 只建立那兩個符號連結，不做別的；它拒絕覆寫不屬於自己的路徑，而 `./install.sh --uninstall` 也只移除自己建立的連結。

接著，在 Codex 裡：

1. 用 Codex 的內建瀏覽器開啟 `https://chatgpt.com` 並登入。
2. 讓你要當主控的那個對話保持選取狀態——該頁面就是主控端。它的輸入框必須停在 `Pro` 模型；若不是，CueLine 會替你選成 `Pro`，否則就拒絕送出。
3. 請 Codex 用 CueLine 處理這件事：*「用 CueLine，讓那個開著的 ChatGPT Pro 對話來指揮這項任務。」*
4. 留著回傳的 `runId`。中斷的執行要續跑，就靠它。

內建的 `cueline` skill 是從 Codex 自己的 Node runtime 驅動這個套件的——內建瀏覽器的物件就活在那裡。另外開一個單獨的 `node` 行程並不會繼承它。

## 從程式碼驅動

```js
import {
  claimCueLineCallerJob,
  continueCueLineRun,
  createCodexIabAdapter,
  heartbeatCueLineCallerJob,
  runCueLine,
  startCueLineCallerJob,
  submitCueLineCallerJobResult,
} from "cueline";

let result = await runCueLine({
  request: "Inspect the repository, delegate an implementation plan, and report the evidence.",
  browser: createCodexIabAdapter({ browser: globalThis.browser }),
  // 選填：conversationUrl、routingConfig / routingConfigPath、home、cwd、
  // runTimeoutMs、signal，以及各工作／預設期限。
}); // 預設 executor: "caller"

while (["awaiting_controller", "awaiting_caller", "awaiting_caller_work"].includes(result.status)) {
  if (result.status === "awaiting_controller") {
    await waitBeforeNextObservation(); // 有界退避；絕不重送
  } else if (result.status === "awaiting_caller") {
    for (const job of result.pendingJobs ?? []) {
      const stdout = await executeExactLocalAdvice(job.spec.task);
      await submitCueLineCallerJobResult(result.runId, job.jobId, {
        status: "succeeded",
        stdout,
      });
    }
  } else {
    for (const job of result.pendingJobs ?? []) {
      if (job.spec.mode !== "work") continue;
      const claim = await claimCueLineCallerJob(result.runId, job.jobId, {
        callerId: "stable-codex-task-identity",
      });
      const proof = {
        claimId: claim.claimId,
        callerId: claim.callerId,
        fencingToken: claim.fencingToken,
      };
      await startCueLineCallerJob(result.runId, job.jobId, proof);
      const stdout = await executeExactLocalWork(job.spec.task, claim.workdir, {
        heartbeat: () => heartbeatCueLineCallerJob(result.runId, job.jobId, proof),
      });
      await submitCueLineCallerJobResult(
        result.runId,
        job.jobId,
        { status: "succeeded", stdout },
        { claim: proof },
      );
    }
  }
  result = await continueCueLineRun({ runId: result.runId });
}

if (result.status === "complete") {
  console.log(result.finalDeliveryText);
}
```

若回傳 `awaiting_controller`，代表同一個精確 request 已送出、但 Pro 回覆尚未被觀測；稍後續跑只會唯讀觀測，不會重送。`awaiting_caller` 交接 `advise`；`awaiting_caller_work` 則必須依序 claim、start、執行、heartbeat 與帶 claim proof 提交結果。Pro 網頁從未直接使用本機工具。

在 Codex 的 runtime 裡，import `cueline api path` 印出的那個絕對路徑模組——那就是你安裝的那份套件建置出來的 API。

`startCueLineRun` 只建立持久 run 並回傳 `ready`；`runCueLine` 會建立並推進到持久 controller 觀測暫停、caller 交接或終態。續跑前先執行 `cueline run status <run-id> --json`。單一正常送出、非人工、具精確 URL、無 job／pending command／取消的 stale caller observer 可被 fencing 後唯讀恢復；其他 stale 狀態仍須正式接管。`caller_work_pending`、`caller_work_claimed`、`caller_work_running` 分別只允許 `claim_caller_work`、`start_caller_work`、`continue_caller_work`，主控的 `dispatch` 本身不代表本機工作已開始。

## CLI

CLI 不驅動瀏覽器。`doctor`、`routing`、`jobs`、`run status`、`api path`、`config path` 都是唯讀；`install`／`uninstall` 只改套件擁有的 skill 連結；`run reconcile`、`run takeover`、`run reconcile-runtime`、`run cancel`／`run stop`、`job cancel` 會追加稽核證據或修改持久 run/job 狀態。執行寫入狀態的命令前，先用 `cueline help` 核對完整參數。

```console
$ cueline install
CueLine skill installed: /Users/you/.codex/skills/cueline

$ cueline doctor
CueLine 0.1.6
status	ok
node	22.14.0	ok
config	/usr/local/lib/node_modules/cueline/config/routing.default.json	valid
home	/Users/you/.cueline
caller_ready	yes
caller_lanes	1
process_available_lanes	1

$ cueline doctor --json
{"version":"0.1.6","status":"ok","node":{"version":"22.14.0","ok":true,"requirement":">=22"},...}

$ cueline api path
/usr/local/lib/node_modules/cueline/dist/src/api.js

$ cueline routing
default	codex-default	available

$ cueline jobs
No jobs.

$ cueline run status run_... --json
{"status":"running","executor":"caller","phase":"caller_jobs_pending","runtime":{"ownership":"missing"},...}

$ cueline run takeover stale_run_... --json
{"runId":"stale_run_...","outcome":"taken_over","next":"continue",...}

$ cueline run cancel run_...
run_...	requested	affected_jobs=0

$ cueline config path
/usr/local/lib/node_modules/cueline/config/routing.default.json

$ cueline uninstall
CueLine skill removed: /Users/you/.codex/skills/cueline
```

Node 版本太舊、或沒有任何已啟用的 caller 通道時，`cueline doctor` 會以非零狀態結束。`process_available_lanes` 可以是 0 而不影響 caller 模式；只有明確選用 process executor 前才需要用 `cueline routing` 檢查 process 可用性。`cueline api path` 印出的就是 skill 會 import 的模組，所以用打包安裝時完全不需要 clone 原始碼。`cueline help` 會列出每個命令的精確語法，包括 `--json` 與人工 reconcile 的必要確認參數。

只有 `run status` 明確顯示 stale owner 時才能用 `run takeover`。新鮮的 active heartbeat 會被拒絕；命令回傳 `next: continue` 或 `next: reconcile_runtime`，請照該值行動，不要自行猜測。

## 設定

`CUELINE_CONFIG` 用來指定路由設定檔；`CUELINE_HOME` 用來搬動本機狀態（預設 `~/.cueline`）。

Caller 模式不會啟動路由行程。只有同時選擇 `executor: "process"` 與 `allowProcessExecution: true` 時，內建的 `default` 通道才會以 `codex-default` 執行隔離的 `codex exec --ignore-user-config`；`advise` 用 `read-only`、`work` 用 `workspace-write`。

狀態放在 `CUELINE_HOME` 底下：

```text
runs/<run-id>/events.jsonl + events.jsonl.segments/   只追加、具權威性
runs/<run-id>/runtime.json.fence + runtime.json.epochs/   有世代隔離的活 owner heartbeat 證據
runs/<run-id>/runtime.json.retired-owners/   不可變的舊 owner 事件截止點
runs/<run-id>/runtime.json.takeover-intents/   不可變的精確 takeover 嘗試紀錄
runs/<run-id>/cancel.json    存在時代表持久取消要求
runs/<run-id>/snapshot.json   重播的最佳化產物，可丟棄
jobs/<job-id>.json            每個工作的執行證據
```

事件日誌才是紀錄本身：主控端的這一輪在送出之前就先寫下、工作在行程啟動之前就先註冊，所以「意圖」與「副作用」之間若被中斷，會留下痕跡。壞掉的快照會被忽略、從第 1 號事件重建，而不是硬信它。

續跑只會接回完全相同的對話網址。ChatGPT 把長文字自動轉成附件時，CueLine 會辨識 `attachment_ready`，且最多只點一次；模糊點擊一律記為 `possibly_sent`，絕不補點或重送。只有實際可見、啟用且可操作的 Stop 按鈕才表示 Pro 仍在回答；隱藏殘留按鈕不會擋住完成回覆。若操作者手動送出附件，用 `cueline run reconcile RUN_ID --request-id REQUEST_ID --manual-send-confirmed` 寫入正式確認；之後仍須通過完全相同的 conversation、Pro 證據與 protocol/run/round/request identity 才能唯讀接回。

送給主控的工作證據優先採用成功且非空的 stdout，全體共用 12,000 字元上限；完整 stdout/stderr 仍保留在本機 job status。若 Pro 接受 `inspect(job_ids)`，下一輪會先替指定 job 保留證據預算，再處理無關工作。

## 驗證

```bash
npm ci
npm run typecheck
npm test
npm run smoke:fake
bash test/shell/install.test.sh
npm pack --dry-run
```

`npm run smoke:fake` 會用假的瀏覽器與假的 runner，離線跑完整個主控迴圈。它證明的是迴圈，不是線上頁面——只有真正透過內建瀏覽器完成一輪，才能證明後者。

## 0.1 的限制

只支援文字控制命令。一次執行只對應一個對話。選成 `Pro` 是 CueLine 唯一會做的模型切換。支援 ChatGPT 自動把長文字轉成附件，但不支援主動上傳檔案、圖片、Deep Research、Projects 或 Apps。Caller `work` 必須經過明確 claim/start，長工作需 heartbeat；process 執行則要雙重明確授權。任何模糊送出或已啟動工作都不會被自動重試。

完整矩陣見 [compatibility](docs/compatibility.md)。

## 文件

[architecture](docs/architecture.md) · [controller protocol](docs/controller-protocol.md) · [runner contract](docs/runner-contract.md) · [state and recovery](docs/state-and-recovery.md) · [compatibility](docs/compatibility.md) · [provenance](docs/provenance.md)（皆為英文）

## 開發

TypeScript、ESM，只用 Node 內建模組。`npm run build` 會編譯到 `dist/`；測試以 `node --test` 跑編譯後的產物。CI 涵蓋 Ubuntu 與 macOS 上的 Node 22 與 24。

CueLine 是獨立專案，與 OpenAI 或任何其他公司皆無隸屬關係，亦未獲其背書或贊助。見 [provenance](docs/provenance.md) 與 [third-party notices](THIRD_PARTY_NOTICES.md)。

## 授權

MIT。見 [LICENSE](LICENSE)。
