import type {
  CueLineRunVerificationReport,
  CueLineRuntimeOptions,
} from "../api-contracts.js";
import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";
import { verifyCueLineRun } from "../api-run-verification.js";
import { safeCueLineRunStatus } from "../core/run-status-view.js";
import { CueLineError } from "../core/errors.js";
import { runtimeEnvironment } from "../core/runtime.js";
import {
  diagnoseCueLineRunStatus,
  type CueLineRunDiagnosis,
} from "../diagnostics/run-doctor.js";
import { defaultCueLineHome } from "../state/paths.js";
import { CUELINE_VERSION } from "../version.js";
import { loadCueLineRunTimeline, type CueLineRunTimeline } from "./run-timeline.js";

export const RUN_BUNDLE_PROTOCOL = "cueline-run-bundle/0.1";

export interface CueLineRunSupportBundle {
  schema: "cueline-run-export/1";
  protocol: typeof RUN_BUNDLE_PROTOCOL;
  version: string;
  generatedAt: string;
  runId: string;
  status: ReturnType<typeof safeCueLineRunStatus>;
  verification: CueLineRunVerificationReport;
  diagnosis: CueLineRunDiagnosis;
  timeline: CueLineRunTimeline;
}

export interface CueLineRunSupportBundleOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {
  timelineLimit?: number;
}

/**
 * One sanitized JSON document for bug reports and cross-machine support:
 * metadata-only status, content-free verification, doctor diagnosis, and the
 * hashed audit timeline. Every section reuses an existing sanitized surface;
 * this module adds no new evidence projection of its own, so it cannot leak
 * more than the surfaces it composes.
 */
export async function buildCueLineRunSupportBundle(
  runId: string,
  options: CueLineRunSupportBundleOptions = {},
): Promise<CueLineRunSupportBundle> {
  const timelineLimit = options.timelineLimit ?? 1000;
  if (
    !Number.isSafeInteger(timelineLimit) ||
    timelineLimit < 1 ||
    timelineLimit > 1000
  ) {
    throw new CueLineError(
      "RUN_BUNDLE_LIMIT_INVALID",
      "timelineLimit must be an integer between 1 and 1000.",
    );
  }
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const shared = {
    home,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
  const status = await loadCueLineRunStatus(runId, {
    ...shared,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const [verification, timeline] = await Promise.all([
    verifyCueLineRun(runId, {
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    loadCueLineRunTimeline(runId, { ...shared, limit: timelineLimit }),
  ]);
  const generatedAt = (options.now === undefined ? new Date() : options.now()).toISOString();
  return {
    schema: "cueline-run-export/1",
    protocol: RUN_BUNDLE_PROTOCOL,
    version: CUELINE_VERSION,
    generatedAt,
    runId,
    status: safeCueLineRunStatus(status),
    verification,
    diagnosis: diagnoseCueLineRunStatus(status),
    timeline,
  };
}
