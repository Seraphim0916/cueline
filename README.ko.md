<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cueline-banner-dark.svg">
  <img alt="CueLine — ChatGPT가 지시하고, 당신의 머신이 실행합니다." src="docs/assets/cueline-banner-light.svg" width="100%">
</picture>

<p align="center">
  <a href="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/Seraphim0916/cueline/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <b>한국어</b>
</p>

**CueLine은 열린 ChatGPT 웹 대화에 판단을 맡깁니다. 대화는 텍스트 명령을 내리고, CueLine이 검증하며, 현재 Codex가 허용된 로컬 작업을 수행합니다.**

웹 페이지에는 로컬 도구가 없습니다. 기본 `caller` 실행에서 `advise`는 조정용 인계이며, `work`는 지속 claim과 start가 필요합니다. 등록된 워커를 띄우는 process executor는 이중 명시 승인이 필요합니다.

CueLine은 독립적인 구현이며 **런타임 npm 의존성이 전혀 없습니다**. Omnilane이나 GPT Relay를 감싼 래퍼가 아닙니다.

## 최신 릴리스: 0.1.6

- caller `work`에 영속적인 claim/start/heartbeat/result fencing을 추가해 시작 전 안전한 회수와 시작 후 `ambiguous` 종결을 지원합니다.
- 숨겨진 `Stop answering` 오탐, inspect 대상 출력 우선순위, stale 읽기 전용 관찰 복구, process 이중 승인, process 상태 관측성을 수정했습니다.
- 번들 process route에 `--ignore-user-config`를 추가하고 이후의 신뢰할 수 없는 출력이 model/provider 상태를 위조하지 못하게 했습니다.
- 267/267 테스트, 깨끗한 패키지 설치, 새 ChatGPT Web Pro run의 최종 `complete`를 재전송이나 중단 없이 검증했습니다.

전체 내용은 [changelog](CHANGELOG.md#016---2026-07-15) 또는 변경 불가능한 [v0.1.6 release](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6)에서 확인할 수 있습니다.

## 실행 한 번은 실제로 이렇게 흘러갑니다

<img alt="Caller-first CueLine: ChatGPT가 텍스트 명령을 내리고 현재 Codex가 로컬 조언 작업을 수행하며 CueLine이 완료까지 제한된 증거를 반환합니다." src="docs/assets/cueline-loop-ko.svg" width="100%">

매 라운드마다 CueLine은 관측 하나를 보내고 나중에 `<CueLineControl>` 엔벨로프를 **정확히 하나만** 읽습니다. 컨트롤러는 `dispatch`, `wait`, `inspect`, `complete`, `blocked` 중 하나를 고릅니다. 루프는 한 번의 영속적인 전송 뒤 `awaiting_controller`에서 일시 중지하며 caller 인계, `complete`, `blocked`, 또는 라운드 상한(기본 12회)에서도 멈춥니다.

기본값이 아닌 `maxRounds`는 run 생성 시 고정되며 owner가 없는 일시 중지를 가로질러 컨트롤러 총 라운드 수를 셉니다. 이후 계속하기에서는 보통 생략해 지속 값을 재사용하고, 다른 값을 전달하면 예산을 몰래 재설정하거나 늘리지 않고 거부합니다.

`startCueLineRun`과 `runCueLine`의 기본값은 `caller`입니다. 전송 뒤 `awaiting_controller`를 반환하고 lease를 해제하며, 계속하기는 재전송 없이 읽기 전용 관측 한 번만 수행합니다. `advise`는 `awaiting_caller`, `work`는 `awaiting_caller_work`를 반환합니다. work는 현재 Codex가 `claimCueLineCallerJob`과 `startCueLineCallerJob`을 성공시키기 전에는 시작되지 않습니다. claim은 run, job, task hash, 절대 workdir, caller identity, fencing token에 묶이며 시작된 work는 자동 재시도되지 않고 만료 시 `ambiguous`가 됩니다. Pro는 텍스트 명령을 제안하고 검토할 뿐 로컬 도구를 쓰지 않습니다.

Process 모드는 `executor: "process"`와 `allowProcessExecution: true`가 모두 필요하며, 비종료 계속하기에서도 두 번째 승인을 다시 전달해야 합니다. 번들 route는 `--ignore-user-config`도 사용하므로 숨은 worker가 사용자 설정 MCP server나 그 명령 인자를 로드하지 않습니다. 레인과 후보는 시작 전에 검증되고 셸이나 시작 후 자동 폴백은 사용하지 않습니다.

컨트롤러 프로토콜은 라우팅 계층을 명확히 구분합니다. `lane`에는 레인 이름인 `default`를 써야 하며, `codex-default`는 그 레인 안의 후보 러너이지 레인이 아닙니다. CueLine은 작업을 하나라도 등록하기 전에 `dispatch` 전체를 검증합니다. 잘못된 레인이나 러너가 하나라도 있으면 일부를 먼저 실행하지 않고 `dispatch` 전체를 수정하도록 돌려보냅니다.

이것은 허용 목록(allow-list)이지 샌드박스가 아닙니다. 등록된 워커는 CueLine 프로세스 자신과 동일한 권한으로 실행됩니다. `advise`는 Codex의 읽기 전용 샌드박스에, `work`는 `workspace-write`에 대응하지만, 당신이 등록한 것이 곧 당신이 승인한 것입니다.

## 컨트롤러는 반드시 Pro 모델이어야 합니다

컴포저의 모델 선택기가 `Pro`를 가리키지 않으면 CueLine은 전송을 거부합니다. 대화가 다른 모델에 머물러 있으면 CueLine이 먼저 컴포저를 `Pro`로 전환합니다 — 이것이 CueLine에게 허용된 유일한 모델 전환입니다. 검증된 실제 실행에서 CueLine은 Instant를 Pro로 전환했고, 응답은 `gpt-5-6-pro`로 돌아왔습니다.

고르는 것과 증명하는 것은 다릅니다. 응답이 올 때마다 CueLine은 완료된 어시스턴트 메시지의 모델 slug를 읽고 그것이 Pro slug이기를 요구합니다. 전송과 응답 사이에 등급이 낮아지더라도 신뢰하지 않고 잡아냅니다. 실패는 `MODEL_SELECTOR_MISSING`, `PRO_MODEL_UNAVAILABLE`, `PRO_MODEL_SELECTION_FAILED`, `PRO_MODEL_MISMATCH`로 드러나며, 받아들여진 답으로 둔갑하는 일은 결코 없습니다.

ChatGPT Pro 구독과 선택된 Pro 모델은 서로 다른 것입니다. 계정이나 프로필 라벨에 `Pro`가 들어 있어도 그것은 구독의 증거일 뿐, 결코 모델의 증거가 되지 않습니다. 모델의 증거가 되는 것은 응답의 모델 slug뿐입니다. 실제 턴마다 `controller_response_received`가 `selected_model_label`, `response_model_slug`, `model_evidence_source`와 함께 저장되므로, 어느 증거가 모델을 입증했는지는 나중에도 감사할 수 있습니다.

## 빠른 시작

필요한 것: Node.js 22 이상, 내장 브라우저를 갖춘 Codex, 그리고 — 기본 제공 레인을 쓴다면 — `PATH` 위의 `codex` CLI.

npm 레지스트리에서 설치합니다:

```bash
npm install -g cueline@0.1.6
cueline install
cueline doctor
```

대안으로, [v0.1.6 릴리스](https://github.com/Seraphim0916/cueline/releases/tag/v0.1.6)의 패키지 tarball을 설치할 수도 있습니다. 같은 릴리스에 `.sha256` 체크섬도 함께 있습니다.

```bash
npm install -g https://github.com/Seraphim0916/cueline/releases/download/v0.1.6/cueline-0.1.6.tgz
cueline install
cueline doctor
```

`cueline install`이 만드는 심볼릭 링크는 하나뿐입니다. 번들된 스킬을 `$CODEX_HOME/skills/cueline`(기본값 `~/.codex/skills/cueline`)에 연결합니다. 자신이 소유하지 않은 경로는 덮어쓰기를 거부하고, 두 번 실행해도 아무것도 달라지지 않습니다. `cueline uninstall`은 그 링크만 제거하며, 그 자리에 다른 파일이 있으면 지우지 않고 보존합니다.

### 소스에서 설치하기

```bash
git clone https://github.com/Seraphim0916/cueline.git
cd cueline
npm ci
npm run build
./install.sh      # ~/.codex/skills/cueline 과 ~/.local/bin/cueline 심볼릭 링크 생성
cueline doctor
```

`install.sh`는 이 두 개의 심볼릭 링크만 만듭니다. 자신이 소유하지 않은 경로는 덮어쓰기를 거부하며, `./install.sh --uninstall` 역시 자신이 만든 링크만 제거합니다.

그다음 Codex에서:

1. Codex의 내장 브라우저로 `https://chatgpt.com`을 열고 로그인합니다.
2. 지휘를 맡길 대화를 선택한 상태로 둡니다. 그 페이지가 컨트롤러입니다. 그 컴포저는 반드시 `Pro` 모델이어야 하며, 그렇지 않으면 CueLine이 `Pro`를 대신 선택하고, 선택하지 못하면 전송을 거부합니다.
3. Codex에게 CueLine으로 처리해 달라고 요청합니다: *"CueLine을 써서, 열려 있는 ChatGPT Pro 대화가 이 작업을 지휘하게 해 줘."*
4. 반환된 `runId`를 보관하세요. 중단된 실행을 이어서 진행하는 열쇠입니다.

기본 제공 `cueline` 스킬은 Codex 자체의 Node 런타임에서 이 패키지를 구동합니다. 내장 브라우저 객체가 바로 그곳에 있기 때문입니다. 옆에서 따로 띄운 평범한 `node` 프로세스는 그것을 물려받지 못합니다.

## 코드에서 구동하기

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
  // 선택: conversationUrl, routingConfig / routingConfigPath, home, cwd,
  // runTimeoutMs, signal, 작업별/기본 제한 시간.
}); // 기본 executor: "caller"

while (["awaiting_controller", "awaiting_caller", "awaiting_caller_work"].includes(result.status)) {
  if (result.status === "awaiting_controller") {
    await waitBeforeNextObservation(); // 제한된 백오프. 재전송 금지
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

`awaiting_controller`는 재전송 없는 읽기 전용 관측, `awaiting_caller`는 advise 인계, `awaiting_caller_work`는 claim, start, 실행, heartbeat, claim proof 제출 순서입니다. Pro는 로컬 도구를 직접 쓰지 않습니다.

Codex 런타임에서는 `cueline api path`가 출력하는 절대 경로 모듈을 import하세요. 그것이 설치한 패키지의 빌드된 API입니다.

`startCueLineRun`은 지속 run을 만들고 `ready`만 반환합니다. `runCueLine`은 생성 후 지속 controller 관측 대기, caller 인계 또는 종료 상태까지 진행합니다. owner가 없는 `controller_response_pending`에 정상 전송된 턴이 정확히 하나이고 `safeNextAction: observe`가 표시되면 같은 Pro 응답을 읽기 전용으로 관측하기 위한 대기입니다. 잠시 뒤 계속하고 재전송하지 마세요. `safeNextAction: reconcile`은 모호하거나 수동 전송되었거나 보류 턴이 여러 개인 경우에 사용합니다. owner가 없는 `caller_jobs_pending`은 정상적인 로컬 인계이며 orphan이나 ChatGPT 대기가 아닙니다.

## CLI

CLI는 브라우저를 구동하지 않습니다. `doctor`, `routing`, `jobs`, `run status`, `run verify`, `api path`, `config path`는 읽기 전용입니다. `install`/`uninstall`은 패키지가 소유한 스킬 링크만 변경합니다. `run reconcile`, `run takeover`, `run reconcile-runtime`, `run cancel`/`run stop`, `job cancel`은 감사 증거를 추가하거나 지속 run/job 상태를 변경합니다. 상태를 쓰는 명령 전에는 `cueline help`로 전체 인수를 확인하세요.

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

$ cueline api path
/usr/local/lib/node_modules/cueline/dist/src/api.js

$ cueline routing
default	codex-default	available

$ cueline jobs
No jobs.

$ cueline run status run_... --json
{"status":"running","executor":"caller","phase":"caller_jobs_pending","runtime":{"ownership":"missing"},...}

$ cueline run verify run_... --json
{"runId":"run_...","outcome":"verified","marker":"valid",...}

$ cueline run takeover stale_run_... --json
{"runId":"stale_run_...","outcome":"taken_over","next":"continue",...}

$ cueline run cancel run_...
run_...	requested	affected_jobs=0

$ cueline config path
/usr/local/lib/node_modules/cueline/config/routing.default.json

$ cueline uninstall
CueLine skill removed: /Users/you/.codex/skills/cueline
```

Node 버전이 너무 낮거나 활성화된 caller 레인이 하나도 없으면 `cueline doctor`는 0이 아닌 코드로 종료합니다. `process_available_lanes`가 0이어도 caller 모드는 저하되지 않습니다. process executor를 명시적으로 선택하기 전에만 `cueline routing`으로 process 가용성을 확인하세요. `cueline api path`가 출력하는 것이 곧 스킬이 import하는 모듈이므로, 패키지로 설치했다면 저장소를 받을 필요가 없습니다. `cueline help`는 `--json`과 수동 reconcile 필수 확인 플래그를 포함한 각 명령의 정확한 구문을 나열합니다.

`run takeover`는 `run status`가 exact stale owner를 표시할 때만 사용합니다. 새로운 active heartbeat는 거부됩니다. 반환된 `next: continue` 또는 `next: reconcile_runtime`을 따르고 추측해서 진행하지 마세요.

## 설정

`CUELINE_CONFIG`는 라우팅 설정 파일을 고르고, `CUELINE_HOME`은 로컬 상태의 위치를 옮깁니다(기본값 `~/.cueline`).

Caller는 프로세스를 띄우지 않습니다. `executor: "process"`와 `allowProcessExecution: true`를 함께 지정한 경우에만 `default` 레인의 `codex-default`가 격리된 `codex exec --ignore-user-config`를 실행합니다. 독립 `advise`의 기본 동시 실행 상한은 전체/레인당 2이고, `work`가 포함된 배치는 직렬입니다.

상태는 `CUELINE_HOME` 아래에 놓입니다:

```text
runs/<run-id>/events.jsonl + events.jsonl.segments/   추가 전용, 정본
runs/<run-id>/runtime.json.fence + runtime.json.epochs/   세대가 격리된 활성 owner heartbeat 증거
runs/<run-id>/runtime.json.retired-owners/   변경 불가능한 이전 owner 이벤트 cutoff
runs/<run-id>/runtime.json.takeover-intents/   변경 불가능한 exact takeover 시도 기록
runs/<run-id>/cancel.json    존재할 때 지속 취소 요청
runs/<run-id>/snapshot.json   재생 최적화용, 버려도 무방
jobs/<job-id>.json            작업별 실행 증거
```

기록 그 자체는 이벤트 로그입니다. 컨트롤러의 턴은 보내기 전에 기록되고, 작업은 프로세스가 시작되기 전에 등록됩니다. 그래서 의도와 부작용 사이에서 중단이 일어나도 흔적이 남습니다. 손상된 스냅샷은 신뢰되지 않고, 무시된 뒤 이벤트 1번부터 다시 만들어집니다.

복구는 완전히 같은 대화 URL에만 연결합니다. ChatGPT가 긴 텍스트를 첨부로 자동 변환하면 `attachment_ready`로 인식하며 전송 클릭은 최대 한 번입니다. 모호한 클릭은 `possibly_sent`가 되고 재전송하지 않습니다. 수동 전송 뒤에는 `cueline run reconcile RUN_ID --request-id REQUEST_ID --manual-send-confirmed`로 정식 확인하고 동일 conversation, Pro 증거, protocol/run/round/request identity를 모두 검증합니다. 컨트롤러 증거는 성공한 비어 있지 않은 stdout을 우선하며 전체 12,000자로 제한하고, 전체 stdout/stderr는 로컬에 보존합니다.

## 검증

```bash
npm ci
npm run typecheck
npm test
npm run smoke:fake
bash test/shell/install.test.sh
npm pack --dry-run
```

`npm run smoke:fake`는 가짜 브라우저와 가짜 runner를 상대로 컨트롤러 루프 전체를 오프라인으로 돌립니다. 이것이 증명하는 것은 루프이지 실제 페이지가 아닙니다. 후자는 내장 브라우저를 통해 실제로 완료된 한 라운드만이 증명할 수 있습니다.

## 0.1의 한계

텍스트 명령 전용입니다. 긴 텍스트의 자동 첨부 변환은 지원하지만 의도적 파일 업로드, 이미지, Deep Research, Projects, Apps는 지원하지 않습니다. Caller work는 명시적 claim/start, process 실행은 이중 승인이 필요합니다. 모호한 전송이나 이미 시작된 작업은 자동 재시도하지 않습니다.

전체 표는 [compatibility](docs/compatibility.md)를 보세요.

## 문서

[architecture](docs/architecture.md) · [controller protocol](docs/controller-protocol.md) · [runner contract](docs/runner-contract.md) · [state and recovery](docs/state-and-recovery.md) · [compatibility](docs/compatibility.md) · [provenance](docs/provenance.md) (모두 영어)

## 개발

TypeScript, ESM, Node 내장 모듈만 사용합니다. `npm run build`는 `dist/`로 컴파일하고, 테스트는 `node --test`로 컴파일된 결과물을 대상으로 실행합니다. CI는 Ubuntu와 macOS의 Node 22와 24를 다룹니다.

CueLine은 독립 프로젝트이며 OpenAI를 비롯한 어떤 회사와도 제휴하거나 보증·후원을 받지 않았습니다. [provenance](docs/provenance.md)와 [third-party notices](THIRD_PARTY_NOTICES.md)를 참고하세요.

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
