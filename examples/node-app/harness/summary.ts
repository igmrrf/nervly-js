/**
 * `artifacts/summary.json` assembly — the machine-readable contract ticket 5 §3
 * pins. {@link buildSummary} emits exactly the contract's fields (no extra
 * keys), and {@link writeSummary} persists it under the artifact directory.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";

export type SummaryStatus = "pass" | "fail" | "error" | "refused";
export type CheckStatus = "pass" | "fail";

export interface CheckResult {
	name: string;
	status: CheckStatus;
	detail: string;
}

export interface SummaryWorkspace {
	slug: string | null;
	id: string | null;
}

export interface RunSummary {
	example: string;
	target: string;
	harnessVersion: string;
	runId: string;
	startedAt: string;
	durationMs: number;
	status: SummaryStatus;
	workspace: SummaryWorkspace;
	checks: CheckResult[];
	artifacts: string[];
}

export interface SummaryInput {
	example: string;
	target: string;
	runId: string;
	startedAt: Date;
	/** Milliseconds since `startedAt`; clamped to a non-negative integer. */
	durationMs: number;
	status: SummaryStatus;
	workspace: SummaryWorkspace;
	checks: CheckResult[];
	artifacts: string[];
}

/** The harness version every repo's example reports. */
export const HARNESS_VERSION = "1";

/** Build the summary object with exactly the contract's fields. */
export function buildSummary(input: SummaryInput): RunSummary {
	return {
		example: input.example,
		target: input.target,
		harnessVersion: HARNESS_VERSION,
		runId: input.runId,
		startedAt: input.startedAt.toISOString(),
		durationMs: Math.max(0, Math.round(input.durationMs)),
		status: input.status,
		workspace: {
			slug: input.workspace.slug,
			id: input.workspace.id,
		},
		checks: input.checks.map((check) => ({
			name: check.name,
			status: check.status,
			detail: redact(check.detail),
		})),
		artifacts: [...input.artifacts],
	};
}

/** Write `summary.json` under `artifactsDir`; returns the absolute path. */
export function writeSummary(
	artifactsDir: string,
	summary: RunSummary,
): string {
	mkdirSync(artifactsDir, { recursive: true });
	const path = join(artifactsDir, "summary.json");
	writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	return path;
}
