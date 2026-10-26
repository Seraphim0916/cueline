import {
  recordCueLineCallerJobProgress,
  startCueLineCallerWorkLease,
  type CueLineCallerWorkLease,
  type CueLineCallerWorkLeaseOptions,
  type CueLineRuntimeOptions,
} from "../api.js";
import type {
  CueLineCallerWorkClaimProof,
  CueLineCallerWorkClaimResult,
  CueLineCallerWorkMutationResult,
  CueLineCallerWorkProgressInput,
} from "../api-contracts.js";
import { CueLineError } from "../core/errors.js";

export interface McpCallerWorkLeaseProof extends CueLineCallerWorkClaimProof {
  runId: string;
  jobId: string;
}

export interface McpCallerWorkLeaseView {
  runId: string;
  jobId: string;
  claimId: string;
  fencingToken: number;
  outcome: "started" | "already_active" | "active" | "inactive" | "ended" | "already_ended";
  active: boolean;
  aborted: boolean;
  heartbeatIntervalMs?: number;
  progressTimeoutMs?: number;
  maxExecutionMs?: number;
  failureCode?: string;
}

function key(runId: string, jobId: string): string {
  return `${runId}\0${jobId}`;
}

function assertSameProof(
  actual: CueLineCallerWorkClaimProof,
  expected: McpCallerWorkLeaseProof,
): void {
  if (
    actual.claimId !== expected.claimId ||
    actual.callerId !== expected.callerId ||
    actual.fencingToken !== expected.fencingToken
  ) {
    throw new CueLineError(
      "MCP_CALLER_WORK_LEASE_PROOF_MISMATCH",
      "Caller-work lease proof does not match the claim retained by this MCP session.",
    );
  }
}

function sameProof(actual: CueLineCallerWorkClaimProof, expected: McpCallerWorkLeaseProof): boolean {
  return (
    actual.claimId === expected.claimId &&
    actual.callerId === expected.callerId &&
    actual.fencingToken === expected.fencingToken
  );
}

function failureCode(failure: unknown): string | undefined {
  if (typeof failure !== "object" || failure === null) return undefined;
  const code = (failure as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function view(
  lease: CueLineCallerWorkLease,
  outcome: McpCallerWorkLeaseView["outcome"],
): McpCallerWorkLeaseView {
  const code = failureCode(lease.failure);
  return {
    runId: lease.runId,
    jobId: lease.jobId,
    claimId: lease.proof.claimId,
    fencingToken: lease.proof.fencingToken,
    outcome,
    active: lease.active,
    aborted: lease.signal.aborted,
    heartbeatIntervalMs: lease.heartbeatIntervalMs,
    progressTimeoutMs: lease.progressTimeoutMs,
    maxExecutionMs: lease.maxExecutionMs,
    ...(code === undefined ? {} : { failureCode: code }),
  };
}

export class McpCallerWorkLeaseRegistry {
  readonly #claims = new Map<string, CueLineCallerWorkClaimResult>();
  readonly #leases = new Map<string, CueLineCallerWorkLease>();
  readonly #starting = new Map<string, {
    claim: CueLineCallerWorkClaimResult;
    promise: Promise<CueLineCallerWorkLease>;
  }>();
  readonly #stopping = new Set<Promise<void>>();
  #closing = false;

  rememberClaim(claim: CueLineCallerWorkClaimResult): void {
    this.#claims.set(key(claim.runId, claim.jobId), claim);
  }

  #retainedClaim(proof: McpCallerWorkLeaseProof): CueLineCallerWorkClaimResult {
    const claim = this.#claims.get(key(proof.runId, proof.jobId));
    if (claim === undefined) {
      throw new CueLineError(
        "MCP_CALLER_WORK_CLAIM_NOT_IN_SESSION",
        "Call cueline_claim_caller_job in this MCP session before using its lease.",
      );
    }
    assertSameProof(claim, proof);
    return claim;
  }

  async start(
    proof: McpCallerWorkLeaseProof,
    options: CueLineCallerWorkLeaseOptions,
  ): Promise<McpCallerWorkLeaseView> {
    if (this.#closing) {
      throw new CueLineError(
        "MCP_CALLER_WORK_LEASE_REGISTRY_CLOSED",
        "This MCP session is closing; no caller-work lease can start.",
      );
    }
    const leaseKey = key(proof.runId, proof.jobId);
    const claim = this.#retainedClaim(proof);

    const pending = this.#starting.get(leaseKey);
    if (pending !== undefined) {
      assertSameProof(pending.claim, proof);
      return view(await pending.promise, "already_active");
    }

    const existing = this.#leases.get(leaseKey);
    if (existing?.active === true) {
      assertSameProof(existing.proof, proof);
      return view(existing, "already_active");
    }
    const promise = this.#startLease(leaseKey, claim, options, existing);
    this.#starting.set(leaseKey, { claim, promise });
    try {
      return view(await promise, "started");
    } finally {
      this.#starting.delete(leaseKey);
    }
  }

  async #startLease(
    leaseKey: string,
    claim: CueLineCallerWorkClaimResult,
    options: CueLineCallerWorkLeaseOptions,
    existing: CueLineCallerWorkLease | undefined,
  ): Promise<CueLineCallerWorkLease> {
    if (existing !== undefined) await existing.stop();
    const lease = await startCueLineCallerWorkLease(claim, options);
    this.#leases.set(leaseKey, lease);
    return lease;
  }

  status(proof: McpCallerWorkLeaseProof): McpCallerWorkLeaseView {
    this.#retainedClaim(proof);
    const lease = this.#leases.get(key(proof.runId, proof.jobId));
    if (lease === undefined) {
      return {
        runId: proof.runId,
        jobId: proof.jobId,
        claimId: proof.claimId,
        fencingToken: proof.fencingToken,
        outcome: "inactive",
        active: false,
        aborted: false,
      };
    }
    assertSameProof(lease.proof, proof);
    return view(lease, lease.active ? "active" : "inactive");
  }

  /**
   * Starts of this claim still in flight finish first, including one retried right after a failed one, so ending it
   * cannot leave a lease running. A start of another claim of the same job is not waited for.
   */
  async #settledStart(leaseKey: string, proof: McpCallerWorkLeaseProof): Promise<void> {
    let waited;
    for (
      let pending = this.#starting.get(leaseKey);
      pending !== undefined && pending !== waited && sameProof(pending.claim, proof);
      pending = this.#starting.get(leaseKey)
    ) {
      waited = pending;
      await pending.promise.catch(() => undefined);
    }
  }

  /**
   * Unregisters the lease before stopping it: a lease started meanwhile under the same key is not dropped, and a
   * concurrent end() or close() does not stop it a second time. close() waits for stops already under way.
   */
  async #stop(leaseKey: string, lease: CueLineCallerWorkLease): Promise<void> {
    if (this.#leases.get(leaseKey) === lease) this.#leases.delete(leaseKey);
    const stopping = lease.stop();
    this.#stopping.add(stopping);
    try {
      await stopping;
    } finally {
      this.#stopping.delete(stopping);
    }
  }

  async end(proof: McpCallerWorkLeaseProof): Promise<McpCallerWorkLeaseView> {
    const leaseKey = key(proof.runId, proof.jobId);
    this.#retainedClaim(proof);
    await this.#settledStart(leaseKey, proof);
    // The claim may have been replaced while waiting.
    this.#retainedClaim(proof);
    const lease = this.#leases.get(leaseKey);
    if (lease === undefined) {
      return {
        runId: proof.runId,
        jobId: proof.jobId,
        claimId: proof.claimId,
        fencingToken: proof.fencingToken,
        outcome: "already_ended",
        active: false,
        aborted: false,
      };
    }
    assertSameProof(lease.proof, proof);
    await this.#stop(leaseKey, lease);
    return { ...view(lease, "ended"), active: false };
  }

  async recordProgress(
    proof: McpCallerWorkLeaseProof,
    input: CueLineCallerWorkProgressInput,
    options: CueLineRuntimeOptions,
  ): Promise<CueLineCallerWorkMutationResult> {
    const lease = this.#leases.get(key(proof.runId, proof.jobId));
    if (lease === undefined) {
      return recordCueLineCallerJobProgress(
        proof.runId,
        proof.jobId,
        proof,
        input,
        options,
      );
    }
    assertSameProof(lease.proof, proof);
    return lease.recordProgress(input);
  }

  async endAfterSubmission(proof: McpCallerWorkLeaseProof): Promise<void> {
    const leaseKey = key(proof.runId, proof.jobId);
    await this.#settledStart(leaseKey, proof);
    const lease = this.#leases.get(leaseKey);
    if (lease === undefined) return;
    assertSameProof(lease.proof, proof);
    await this.#stop(leaseKey, lease);
  }

  async close(): Promise<void> {
    // Refuse new starts first: one beginning after the pending list is read would otherwise outlive close().
    this.#closing = true;
    await Promise.allSettled([...this.#starting.values()].map(({ promise }) => promise));
    const stops = [...this.#leases].map(([leaseKey, lease]) => this.#stop(leaseKey, lease));
    await Promise.all([...stops, ...this.#stopping]);
  }
}
