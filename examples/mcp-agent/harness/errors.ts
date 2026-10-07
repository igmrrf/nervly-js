/**
 * The mcp-agent harness failure taxonomy. Each kind maps to exactly one
 * contract exit code and summary status
 * (`nervly-base/docs/examples/harness-contract.md` §3):
 *
 * | kind      | exit | summary status |
 * |-----------|------|----------------|
 * | `pass`    | 0    | `pass`         |
 * | `fail`    | 1    | `fail`         |
 * | `error`   | 2    | `error`        |
 * | `refused` | 3    | `refused`      |
 */

import type { CheckResult } from "./summary.js";

export type HarnessFailureKind = "fail" | "error" | "refused";

export const EXIT_CODES: Readonly<Record<HarnessFailureKind, number>> = {
	fail: 1,
	error: 2,
	refused: 3,
};

export class HarnessFailure extends Error {
	readonly kind: HarnessFailureKind;
	readonly exitCode: number;
	/** The check to record alongside the failure, when the failing phase is a check. */
	readonly check: CheckResult | undefined;

	constructor(
		kind: HarnessFailureKind,
		message: string,
		check?: CheckResult,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HarnessFailure";
		this.kind = kind;
		this.exitCode = EXIT_CODES[kind];
		this.check = check;
	}
}

/** Refused before doing any work (guard refusal). */
export class GuardRefusal extends HarnessFailure {
	constructor(message: string) {
		super("refused", message);
		this.name = "GuardRefusal";
	}
}

/** Environment or bootstrap failure (stack unreachable, API rejected, timeout). */
export class EnvironmentFailure extends HarnessFailure {
	constructor(message: string, check?: CheckResult, options?: ErrorOptions) {
		super("error", message, check, options);
		this.name = "EnvironmentFailure";
	}
}

/** An asserted end state did not hold. */
export class AssertionFailure extends HarnessFailure {
	constructor(message: string, check?: CheckResult, options?: ErrorOptions) {
		super("fail", message, check, options);
		this.name = "AssertionFailure";
	}
}
