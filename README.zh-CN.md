<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cueline-banner-dark.svg">
  <img alt="CueLine — ChatGPT 下指令，你的机器执行。" src="docs/assets/cueline-banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a> · <b>简体中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

**CueLine 把方向盘交给一个已经打开的 ChatGPT 网页会话：由它规划运行、发出每一步文本指令；CueLine 负责校验，当前 Codex 才在本机执行获准的工作。**

那个网页碰不到你的机器，也没有本地工具。CueLine 默认把 `advise` 作业持久化并交回当前 Codex 执行；只有显式选择 `process` executor，才会启动已注册的本地 worker。

CueLine 是独立实现，**没有任何运行时 npm 依赖**，也不是 Omnilane 或 GPT Relay 的包装层。

## 一次运行实际是怎么走的

<img alt="Caller-first CueLine 运行：ChatGPT 发出文本命令，当前 Codex 执行本地只读检查，CueLine 回传有界证据直至 complete。" src="docs/assets/cueline-loop-zh-CN.svg" width="100%">

每一轮：CueLine 先把“接下来要问什么”写入记录，向会话发送一份观测（observation），之后再读回**恰好一个** `<CueLineControl>` 信封。控制器从五个动作中选一个——`dispatch`、`wait`、`inspect`、`complete`、`blocked`——信封之外的任何文本都不会被执行。循环会在一次可靠发送后以 `awaiting_controller` 暂停，也会停在 caller 交接、`complete`、`blocked` 或轮次上限（默认 12 轮）。

非默认的 `maxRounds` 会在创建 run 时固定，并跨所有无 owner 的暂停累计控制器总轮次。后续继续通常省略它并复用持久值；传入不同数值会被拒绝，不会暗中重置或放宽预算。

`startCueLineRun` 与 `runCueLine` 都默认使用 `caller`。使用内置浏览器时，CueLine 只发送一次、保存精确会话 URL，然后返回 `awaiting_controller` 并释放 runtime lease，不会让单次工具调用一直等待 Pro。之后的 `continueCueLineRun` 只做一次只读观测；若尚未完成，会再次返回 `awaiting_controller`，绝不重发。`dispatch` 才返回 `awaiting_caller`；当前 Codex 执行各个 `advise` 任务、调用 `submitCueLineCallerJobResult`，再继续同一 run。Pro 控制器只下文本命令，不能使用本地工具。Caller advice 没有 execution claim，请协调由单一 session 执行；两个 session 可能都做同一项检查，但只有第一份提交的终态证据生效。Caller 模式明确拒绝 `work`。

控制器决定*应该发生什么*；本地这一侧决定*是否允许发生、以何种方式发生*：通道（lane）必须启用、候选必须在任何进程启动**之前**确认可用、`argv[0]` 必须早已由你的路由配置注册。没有任何内容会经过 shell。worker 一旦启动，就不会悄悄退回到第二个候选——失败以证据的形式返回，而不是自动重试。

控制器协议有意区分路由层级：`lane` 填的是通道名称 `default`；`codex-default` 是该通道内的候选执行器，不是通道。CueLine 会在注册任何作业之前先验证整份 `dispatch`；只要包含无效通道或执行器，整份派工就会被退回修复，不会先执行其中一部分。

这是白名单（allow-list），不是沙箱。已注册的 worker 拥有与 CueLine 进程本身相同的权限；`advise` 对应 Codex 的只读沙箱、`work` 对应 `workspace-write`，但你注册了什么，就等于你授权了什么。

## 控制器必须是 Pro 模型

除非输入框的模型选择器显示 `Pro`，否则 CueLine 拒绝发送。会话若停在别的模型，CueLine 会先把输入框切换到 `Pro`——这是它唯一被允许做的模型切换。在一次已验证的实机运行中，它把 Instant 切换为 Pro，返回的响应是 `gpt-5-6-pro`。

选中不等于证明。每次响应之后，CueLine 会读取该条已完成助手消息的模型 slug，并要求它是 Pro 的 slug；发送与回复之间若发生降级，会被抓出来，而不是被信任。失败会以 `MODEL_SELECTOR_MISSING`、`PRO_MODEL_UNAVAILABLE`、`PRO_MODEL_SELECTION_FAILED` 或 `PRO_MODEL_MISMATCH` 暴露出来——绝不会变成一个被接受的答案。

ChatGPT Pro 订阅套餐与“选定的 Pro 模型”是两回事。账号或个人资料标签上出现 `Pro`，只是订阅套餐的证据，永远不算模型证据；只有响应的模型 slug 才算。每一轮实机回合都会持久化 `controller_response_received`，携带 `selected_model_label`、`response_model_slug` 与 `model_evidence_source`，因此“是哪一种证据证明了模型”事后依然可审计。

## 五分钟上手

你需要 Node.js 22 以上、带内置浏览器的 Codex，以及——若使用内置的默认通道——`PATH` 上有 `codex` CLI。

从 npm registry 安装：

```bash
npm install -g cueline@0.1.5
cueline install
cueline doctor
```

作为后备，也可以安装 [v0.1.5 release](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.5) 上的打包 tarball，该 release 同时附带它的 `.sha256` 校验值：

```bash
npm install -g https://github.com/Seraphim0916/cueline/releases/download/v0.1.5/cueline-0.1.5.tgz
cueline install
cueline doctor
```

`cueline install` 只创建一个软链接：把内置的 skill 接到 `$CODEX_HOME/skills/cueline`（默认 `~/.codex/skills/cueline`）。它拒绝覆盖不属于自己的路径，重复执行也不会产生副作用。`cueline uninstall` 只移除那一个链接；若该位置换成了别人的文件，它会保留而不删除。

### 从源码安装

```bash
git clone https://github.com/Seraphim0916/cueline.git
cd cueline
npm ci
npm run build
./install.sh      # 创建 ~/.codex/skills/cueline 与 ~/.local/bin/cueline 两个软链接
cueline doctor
```

`install.sh` 只创建这两个软链接，不做别的；它拒绝覆盖不属于自己的路径，而 `./install.sh --uninstall` 也只移除自己创建的链接。

然后，在 Codex 里：

1. 用 Codex 的内置浏览器打开 `https://chatgpt.com` 并登录。
2. 让你想让它当控制器的那个会话保持选中——该页面就是控制器。它的输入框必须停在 `Pro` 模型；若不是，CueLine 会替你选成 `Pro`，否则就拒绝发送。
3. 让 Codex 用 CueLine 处理任务：*“用 CueLine，让那个打开的 ChatGPT Pro 会话来指挥这项任务。”*
4. 保留返回的 `runId`。被中断的运行要续跑，就靠它。

内置的 `cueline` skill 是从 Codex 自身的 Node runtime 驱动这个包的——内置浏览器对象就存在于那里。另外单独启动的 `node` 进程不会继承它。

## 从代码驱动

```js
import {
  continueCueLineRun,
  createCodexIabAdapter,
  runCueLine,
  submitCueLineCallerJobResult,
} from "cueline";

let result = await runCueLine({
  request: "Inspect the repository, delegate an implementation plan, and report the evidence.",
  browser: createCodexIabAdapter(),
  // 可选：conversationUrl、routingConfig / routingConfigPath、home、cwd、
  // runTimeoutMs、signal，以及作业/默认期限。
}); // 默认 executor: "caller"

while (result.status === "awaiting_controller" || result.status === "awaiting_caller") {
  if (result.status === "awaiting_controller") {
    await waitBeforeNextObservation(); // 有界退避；绝不重发
  } else {
    for (const job of result.pendingJobs ?? []) {
      const stdout = await executeExactLocalAdvice(job.spec.task);
      await submitCueLineCallerJobResult(result.runId, job.jobId, {
        status: "succeeded",
        stdout,
      });
    }
  }
  result = await continueCueLineRun({ runId: result.runId });
}

if (result.status === "complete") {
  console.log(result.finalDeliveryText);
}
```

若返回 `awaiting_controller`，表示同一个精确 request 已发送、但 Pro 回复尚未被观测；稍后继续只会执行只读观测，不会重发。若返回 `awaiting_caller`，由当前 Codex 执行 `result.pendingJobs` 中的每个 `advise`，用 `submitCueLineCallerJobResult` 提交真实结果，再调用 `continueCueLineRun`。这不是 Pro 网页直接使用本地工具。

在 Codex 的 runtime 里，import `cueline api path` 打印出的那个绝对路径模块——那就是你安装的那份包构建出来的 API。

`startCueLineRun` 只创建持久 run 并返回 `ready`；`runCueLine` 创建并推进到持久 controller 观测暂停、caller 交接或终态。缺少 owner 的 `controller_response_pending` 若只有一个正常发送的回合且显示 `safeNextAction: observe`，表示同一个 Pro 回复仍待只读观测；稍后继续即可且不得重发。`safeNextAction: reconcile` 只用于模糊、人工发送或多个待对账回合。缺少 owner 的 `caller_jobs_pending` 是正常本地交接，并非 orphan，也不是仍在等 ChatGPT。

## CLI

CLI 不驱动浏览器。`doctor`、`routing`、`jobs`、`run status`、`api path`、`config path` 都是只读；`install`/`uninstall` 只修改包所拥有的 skill 链接；`run reconcile`、`run takeover`、`run reconcile-runtime`、`run cancel`/`run stop`、`job cancel` 会追加审计证据或修改持久 run/job 状态。执行写入状态的命令前，先用 `cueline help` 核对完整参数。

```console
$ cueline install
CueLine skill installed: /Users/you/.codex/skills/cueline

$ cueline doctor
CueLine 0.1.5
status	ok
node	22.14.0	ok
config	/usr/local/lib/node_modules/cueline/config/routing.default.json	valid
home	/Users/you/.cueline
caller_ready	yes
caller_lanes	1
process_available_lanes	1

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

当 Node 版本过旧、或没有任何已启用的 caller 通道时，`cueline doctor` 会以非零状态退出。`process_available_lanes` 可以为 0 而不影响 caller 模式；只有显式选择 process executor 前才需要用 `cueline routing` 检查 process 可用性。`cueline api path` 打印的就是 skill 会 import 的模块，所以使用打包安装时完全不需要 clone 源码。`cueline help` 会列出每个命令的精确语法，包括 `--json` 和人工 reconcile 的必需确认参数。

只有 `run status` 明确显示 stale owner 时才能使用 `run takeover`。新鲜的 active heartbeat 会被拒绝；命令返回 `next: continue` 或 `next: reconcile_runtime`，请按该值行动，不要自行猜测。

## 配置

`CUELINE_CONFIG` 用于指定路由配置文件；`CUELINE_HOME` 用于迁移本地状态（默认 `~/.cueline`）。

Caller 模式不会启动路由进程。只有显式选择 `process` executor 时，内置 `default` 通道才以 `codex-default` 运行 `codex exec`；独立 `advise` 默认全局/每 lane 并发上限均为 2，包含 `work` 的批次保持串行。

状态位于 `CUELINE_HOME` 之下：

```text
runs/<run-id>/events.jsonl + events.jsonl.segments/   仅追加、具权威性
runs/<run-id>/runtime.json.fence + runtime.json.epochs/   带世代隔离的活跃 owner heartbeat 证据
runs/<run-id>/runtime.json.retired-owners/   不可变的旧 owner 事件截止点
runs/<run-id>/runtime.json.takeover-intents/   不可变的精确 takeover 尝试记录
runs/<run-id>/cancel.json    存在时表示持久取消请求
runs/<run-id>/snapshot.json   重放优化产物，可丢弃
jobs/<job-id>.json            每个作业的执行证据
```

事件日志才是记录本身：控制器这一轮在发送之前先写入、作业在进程启动之前先注册，因此“意图”与“副作用”之间若被中断，会留下痕迹。损坏的快照会被忽略并从第 1 号事件重建，而不是被信任。

续跑只接回完全相同的会话 URL。ChatGPT 自动把长文本转换成附件时，CueLine 识别 `attachment_ready` 且最多点击一次；模糊点击记为 `possibly_sent`，绝不补点或重发。人工发送附件后，使用 `cueline run reconcile RUN_ID --request-id REQUEST_ID --manual-send-confirmed` 写入正式确认；仍须通过完全一致的 conversation、Pro 证据与 protocol/run/round/request identity。控制器证据优先使用成功且非空的 stdout，全局上限 12,000 字符；完整 stdout/stderr 保留在本地。

## 验证

```bash
npm ci
npm run typecheck
npm test
npm run smoke:fake
bash test/shell/install.test.sh
npm pack --dry-run
```

`npm run smoke:fake` 用假的浏览器与假的 runner，离线跑完整个控制循环。它证明的是循环，而不是线上页面——只有通过内置浏览器真正完成一轮，才能证明后者。

## 0.1 的限制

仅支持文本控制命令。一次运行只对应一个会话。支持 ChatGPT 自动将长文本转为附件，但不支持主动文件上传、图片、Deep Research、Projects 或 Apps。Caller 模式只允许 `advise`；`work` 必须显式选择 process executor。模糊发送和已启动工作都不会被自动重试。

完整矩阵见 [compatibility](docs/compatibility.md)。

## 文档

[architecture](docs/architecture.md) · [controller protocol](docs/controller-protocol.md) · [runner contract](docs/runner-contract.md) · [state and recovery](docs/state-and-recovery.md) · [compatibility](docs/compatibility.md) · [provenance](docs/provenance.md)（均为英文）

## 开发

TypeScript、ESM，仅使用 Node 内置模块。`npm run build` 编译到 `dist/`；测试以 `node --test` 运行编译产物。CI 覆盖 Ubuntu 与 macOS 上的 Node 22 与 24。

CueLine 是独立项目，与 OpenAI 或任何其他公司均无隶属关系，也未获其背书或赞助。见 [provenance](docs/provenance.md) 与 [third-party notices](THIRD_PARTY_NOTICES.md)。

## 许可证

MIT。见 [LICENSE](LICENSE)。
