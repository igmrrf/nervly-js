/**
 * The mcp-agent transcript: one redacted line at a time to stdout (unless
 * `--json` is set, where stdout belongs to the summary) and written fresh per
 * run to `artifacts/mcp-agent/transcript.log`.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";

export interface TranscriptOptions {
	artifactsDir: string;
	/** When true, stdout is reserved for the final summary JSON. */
	jsonMode?: boolean;
	/** Test seam; defaults to `process.stdout.write`. */
	stdout?: (line: string) => void;
}

export class Transcript {
	readonly transcriptPath: string;
	private directoryReady = false;
	private hasWritten = false;

	constructor(private readonly options: TranscriptOptions) {
		this.transcriptPath = join(options.artifactsDir, "transcript.log");
	}

	line(message: string): void {
		const text = redact(message);
		if (!this.directoryReady) {
			mkdirSync(this.options.artifactsDir, { recursive: true });
			this.directoryReady = true;
		}
		if (!this.hasWritten) {
			// Each run owns its transcript; a previous run's log is replaced.
			writeFileSync(this.transcriptPath, "", "utf8");
			this.hasWritten = true;
		}
		appendFileSync(this.transcriptPath, `${text}\n`, "utf8");
		if (!this.options.jsonMode) {
			const stdout =
				this.options.stdout ?? ((line: string) => process.stdout.write(line));
			stdout(`${text}\n`);
		}
	}

	blank(): void {
		this.line("");
	}
}
