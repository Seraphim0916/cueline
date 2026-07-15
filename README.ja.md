<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cueline-banner-dark.svg">
  <img alt="CueLine — ChatGPT が指示し、あなたのマシンが実行する。" src="docs/assets/cueline-banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b> · <a href="README.ko.md">한국어</a>
</p>

**CueLine は、開いている ChatGPT のウェブ会話に判断を任せます。会話側はテキストコマンドを出し、CueLine が検証し、現在の Codex が許可されたローカル作業を実行します。**

ウェブページにローカルツールはありません。既定の `caller` 実行では、`advise` は協調用の引き渡し、`work` は永続 claim と start が必要です。登録済みワーカーを起動する process executor には二重の明示的承認が必要です。

CueLine は独立した実装で、**ランタイムの npm 依存はゼロ**です。Omnilane や GPT Relay のラッパーではありません。

## 最新リリース：0.1.6

- caller `work` に永続的な claim／start／heartbeat／result fencing を追加し、開始前の安全な回収と開始後の `ambiguous` 収束を実装しました。
- 非表示の `Stop answering` 誤検知、inspect 対象出力の優先、stale 読み取り専用観測の復旧、process 二重認可、process 状態の可観測性を修正しました。
- 組み込み process route に `--ignore-user-config` を追加し、後続の信頼できない出力による model/provider 状態の偽装を防ぎました。
- 267/267 テスト、クリーンインストール、新規 ChatGPT Web Pro run の終端 `complete` を、再送・中断なしで検証しました。

詳細は [changelog](CHANGELOG.md#016---2026-07-15) または不変の [v0.1.6 release](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6) を参照してください。

## 1 回の実行は実際にどう進むか

<img alt="Caller-first CueLine：ChatGPT がテキストコマンドを出し、現在の Codex がローカル助言を実行し、CueLine が完了まで有界な証拠を返す。" src="docs/assets/cueline-loop-ja.svg" width="100%">

各ラウンドで CueLine は観測を送り、後で `<CueLineControl>` エンベロープを**ちょうど 1 つだけ**読み戻します。コントローラーは `dispatch`、`wait`、`inspect`、`complete`、`blocked` のいずれかを選びます。ループは 1 回の永続的な送信後に `awaiting_controller` で一時停止し、caller への引き渡し、`complete`、`blocked`、またはラウンド上限（既定 12 回）でも停止します。

既定値以外の `maxRounds` は run 作成時に固定され、owner 不在の一時停止をまたいでコントローラーの総ラウンド数を数えます。後の続行では通常省略して永続値を再利用し、異なる値を渡すと予算を暗黙にリセットまたは拡張せず拒否します。

`startCueLineRun` と `runCueLine` の既定は `caller` です。送信後は `awaiting_controller` を返して lease を解放し、続行は 1 回の読み取り専用観測だけを行い、再送しません。`advise` は `awaiting_caller`、`work` は `awaiting_caller_work` を返します。work は現在の Codex が `claimCueLineCallerJob` と `startCueLineCallerJob` を成功させるまで開始されません。claim は run、job、task hash、絶対 workdir、caller identity、fencing token に結び付けられ、開始済み work は自動再試行されず、期限切れなら `ambiguous` になります。Pro はテキスト命令を提案・審査するだけで、ローカルツールは使いません。

Process モードは `executor: "process"` と `allowProcessExecution: true` の両方が必要で、非終端の続行でも第 2 の承認を再度渡します。組み込み route はさらに `--ignore-user-config` を使い、隠れた worker がユーザー設定の MCP server やそのコマンド引数を読み込まないようにします。レーンと候補は起動前に検証され、シェルも起動後の自動フォールバックも使いません。

コントローラープロトコルでは、ルーティングの階層を明確に区別します。`lane` に指定するのはレーン名の `default` であり、`codex-default` はそのレーン内の候補ランナーであって、レーンではありません。CueLine はジョブを一つでも登録する前に `dispatch` 全体を検証します。無効なレーンまたはランナーが一つでもあれば、途中まで実行せず、`dispatch` 全体を修正のために差し戻します。

これは許可リスト（allow-list）であって、サンドボックスではありません。登録されたワーカーは CueLine プロセス自身と同じ権限で動きます。`advise` は Codex の読み取り専用サンドボックスに、`work` は `workspace-write` に対応しますが、登録したものが、そのまま許可したものになります。

## コントローラーは Pro モデルでなければならない

コンポーザーのモデルセレクターが `Pro` を示していないかぎり、CueLine は送信を拒否します。会話が別のモデルにある場合、CueLine はまずコンポーザーを `Pro` に切り替えます——それが唯一許されたモデル切り替えです。検証済みのライブ実行では、Instant を Pro に切り替え、応答は `gpt-5-6-pro` として返りました。

選ぶことと、証明することは違います。各応答のあと CueLine は、完了したアシスタントメッセージのモデル slug を読み、それが Pro の slug であることを要求します。送信から返信までのあいだに格下げが起きても、信用せずに検出します。失敗は `MODEL_SELECTOR_MISSING`、`PRO_MODEL_UNAVAILABLE`、`PRO_MODEL_SELECTION_FAILED`、`PRO_MODEL_MISMATCH` として表面化し、受理された回答になることは決してありません。

ChatGPT Pro のサブスクリプションと、選択された Pro モデルは別物です。アカウントやプロフィールのラベルに `Pro` が含まれていても、それはサブスクリプションの証拠にすぎず、モデルの証拠には決してなりません。モデルの証拠になるのは応答のモデル slug だけです。ライブのターンごとに `controller_response_received` が `selected_model_label`、`response_model_slug`、`model_evidence_source` とともに永続化されるため、どちらの証拠がモデルを裏づけたのかは後からでも監査できます。

## クイックスタート

必要なもの：Node.js 22 以上、組み込みブラウザーを備えた Codex、そして——同梱の既定レーンを使う場合は——`PATH` 上の `codex` CLI。

npm レジストリからインストールします。

```bash
npm install -g cueline@0.1.6
cueline install
cueline doctor
```

フォールバックとして、[v0.1.6 リリース](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6) のパッケージ済み tarball をインストールすることもできます。同じリリースに `.sha256` チェックサムも置いてあります。

```bash
npm install -g https://github.com/Seraphim0916/cueline/releases/download/v0.1.6/cueline-0.1.6.tgz
cueline install
cueline doctor
```

`cueline install` が作るシンボリックリンクは 1 つだけ、同梱スキルを `$CODEX_HOME/skills/cueline`（既定では `~/.codex/skills/cueline`）に張ります。自分が所有していないパスの置き換えは拒否し、二度実行しても何も変わりません。`cueline uninstall` はそのリンクだけを外します。そこに他人のファイルがあれば、削除せず保持します。

### ソースからインストールする

```bash
git clone https://github.com/Seraphim0916/cueline.git
cd cueline
npm ci
npm run build
./install.sh      # ~/.codex/skills/cueline と ~/.local/bin/cueline のシンボリックリンクを作成
cueline doctor
```

`install.sh` が作るのはこの 2 つのシンボリックリンクだけです。自分が所有していないパスの上書きは拒否し、`./install.sh --uninstall` も自分が作ったリンクだけを削除します。

次に、Codex で：

1. Codex の組み込みブラウザーで `https://chatgpt.com` を開き、サインインします。
2. 主導させたい会話を選択したままにします。そのページがコントローラーです。そのコンポーザーは `Pro` モデルでなければなりません。そうでない場合、CueLine が `Pro` を選び、選べなければ送信を拒否します。
3. Codex にこう頼みます：*「CueLine を使って、開いている ChatGPT Pro の会話にこのタスクを指揮させて。」*
4. 返ってきた `runId` を控えておきます。中断した実行を再開する手がかりになります。

同梱の `cueline` スキルは、Codex 自身の Node ランタイムからこのパッケージを駆動します。組み込みブラウザーのオブジェクトはそこに存在するためです。別に起動したプレーンな `node` プロセスはそれを継承しません。

## コードから駆動する

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
  // 任意：conversationUrl、routingConfig / routingConfigPath、home、cwd、
  // runTimeoutMs、signal、ジョブごと／既定の期限。
}); // 既定は executor: "caller"

while (["awaiting_controller", "awaiting_caller", "awaiting_caller_work"].includes(result.status)) {
  if (result.status === "awaiting_controller") {
    await waitBeforeNextObservation(); // 有界バックオフ。再送しない
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
      const claim = await claimCueLineCallerJob(result.runId, job.jobId, { callerId: "stable-codex-task-identity" });
      const proof = { claimId: claim.claimId, callerId: claim.callerId, fencingToken: claim.fencingToken };
      await startCueLineCallerJob(result.runId, job.jobId, proof);
      const stdout = await executeExactLocalWork(job.spec.task, claim.workdir, {
        heartbeat: () => heartbeatCueLineCallerJob(result.runId, job.jobId, proof),
      });
      await submitCueLineCallerJobResult(result.runId, job.jobId, { status: "succeeded", stdout }, { claim: proof });
    }
  }
  result = await continueCueLineRun({ runId: result.runId });
}

if (result.status === "complete") {
  console.log(result.finalDeliveryText);
}
```

`awaiting_controller` は再送なしの読み取り専用観測、`awaiting_caller` は advise の引き渡し、`awaiting_caller_work` は claim、start、実行、heartbeat、claim proof 付き提出の順です。Pro はローカルツールを直接使いません。

Codex のランタイムでは、`cueline api path` が出力する絶対パスのモジュールを import します。それがインストールしたパッケージのビルド済み API です。

`startCueLineRun` は永続 run を作成して `ready` を返すだけです。`runCueLine` は作成後、永続 controller 観測待ち、caller 引き渡し、または終端まで進めます。owner 不在の `controller_response_pending` で通常送信済みターンが一つだけあり、`safeNextAction: observe` が示される場合、同じ Pro 応答を読み取り専用で観測する待機です。少し待って続行し、再送しません。`safeNextAction: reconcile` は曖昧、手動送信、または複数の保留ターンに使います。owner 不在の `caller_jobs_pending` は正常なローカル引き渡しであり、orphan や ChatGPT 待ちではありません。

## CLI

CLI はブラウザーを駆動しません。`doctor`、`routing`、`jobs`、`run status`、`api path`、`config path` は読み取り専用です。`install`/`uninstall` はパッケージ所有のスキルリンクだけを変更します。`run reconcile`、`run takeover`、`run reconcile-runtime`、`run cancel`/`run stop`、`job cancel` は監査証拠を追記するか、永続 run/job 状態を変更します。状態を書き込むコマンドの前に `cueline help` で完全な引数を確認してください。

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

Node が古すぎる場合、または有効な caller レーンが一つもない場合、`cueline doctor` は非ゼロで終了します。`process_available_lanes` が 0 でも caller モードは劣化しません。process executor を明示的に選ぶ前だけ `cueline routing` で process の可用性を確認してください。`cueline api path` が出すのはスキルが import するモジュールなので、パッケージ導入ならリポジトリの取得は不要です。`cueline help` は `--json` と手動 reconcile の必須確認フラグを含む各コマンドの正確な構文を一覧します。

`run takeover` は `run status` が exact stale owner を示す場合だけ使います。新しい active heartbeat は拒否されます。返された `next: continue` または `next: reconcile_runtime` に従い、推測で進めないでください。

## 設定

`CUELINE_CONFIG` はルーティング設定ファイルを選び、`CUELINE_HOME` はローカル状態の置き場所を移します（既定は `~/.cueline`）。

Caller はプロセスを起動しません。`executor: "process"` と `allowProcessExecution: true` を同時に指定した場合だけ、`default` レーンの `codex-default` が隔離された `codex exec --ignore-user-config` を実行します。独立した `advise` の既定同時実行数は全体／レーンごとに 2、`work` を含むバッチは直列です。

状態は `CUELINE_HOME` の下に置かれます：

```text
runs/<run-id>/events.jsonl + events.jsonl.segments/   追記のみ、正本
runs/<run-id>/runtime.json.fence + runtime.json.epochs/   世代分離されたライブ owner heartbeat 証拠
runs/<run-id>/runtime.json.retired-owners/   不変の旧 owner イベント cutoff
runs/<run-id>/runtime.json.takeover-intents/   不変の exact takeover 試行記録
runs/<run-id>/cancel.json    存在する場合は永続キャンセル要求
runs/<run-id>/snapshot.json   リプレイの最適化、破棄可能
jobs/<job-id>.json            ジョブごとの実行証拠
```

記録そのものはイベントログです。コントローラーのターンは送信する前に書かれ、ジョブはプロセスが起動する前に登録されます。だからこそ、意図と副作用のあいだで中断が起きても痕跡が残ります。壊れたスナップショットは信用されず、無視されてイベント 1 番から再構築されます。

復帰は完全に同じ会話 URL にだけ接続します。ChatGPT が長文を添付に自動変換した場合は `attachment_ready` として認識し、送信クリックは最大 1 回です。曖昧なクリックは `possibly_sent` となり再送しません。手動送信後は `cueline run reconcile RUN_ID --request-id REQUEST_ID --manual-send-confirmed` で正式に確認し、同一 conversation、Pro 証拠、protocol/run/round/request identity をすべて検証します。コントローラー証拠は成功時の非空 stdout を優先し、全体 12,000 文字に制限します。完全な stdout/stderr はローカルに保持します。

## 検証

```bash
npm ci
npm run typecheck
npm test
npm run smoke:fake
bash test/shell/install.test.sh
npm pack --dry-run
```

`npm run smoke:fake` は、偽のブラウザーと偽の runner を相手に、コントローラーループ全体をオフラインで走らせます。証明できるのはループであって、ライブのページではありません。後者を証明できるのは、組み込みブラウザーを通じて実際に完了した 1 ラウンドだけです。

## 0.1 の制限

テキストコマンドのみ。長文の自動添付変換は対応しますが、意図的なファイルアップロード、画像、Deep Research、Projects、Apps は非対応です。Caller work は明示的な claim/start、process 実行は二重承認が必要です。曖昧な送信や開始済みジョブを自動再試行しません。

完全な対応表は [compatibility](docs/compatibility.md) を参照してください。

## ドキュメント

[architecture](docs/architecture.md) · [controller protocol](docs/controller-protocol.md) · [runner contract](docs/runner-contract.md) · [state and recovery](docs/state-and-recovery.md) · [compatibility](docs/compatibility.md) · [provenance](docs/provenance.md)（いずれも英語）

## 開発

TypeScript、ESM、Node の組み込みモジュールのみ。`npm run build` は `dist/` へコンパイルし、テストは `node --test` でコンパイル済みの成果物に対して実行します。CI は Ubuntu と macOS 上の Node 22 / 24 を対象とします。

CueLine は独立したプロジェクトであり、OpenAI やその他いかなる企業とも提携しておらず、推奨・後援も受けていません。[provenance](docs/provenance.md) と [third-party notices](THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
