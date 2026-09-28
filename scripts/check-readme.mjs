#!/usr/bin/env node
/**
 * README-as-tested gate (checklist.md Documentation#01, ticket 27's option 3.3).
 *
 * The README quickstart is a promise: a stranger copies its snippets, installs
 * `@nervly/sdk`, and the code compiles against the SDK they get. That promise
 * decayed silently once already — the README described methods that do not
 * exist until ticket 12 corrected it by hand. So this gate makes the README
 * checked content on every build, in two halves:
 *
 *   1. **Contract check (type-level).** Every `typescript` fenced block in
 *      README.md is extracted into `docs/readme-snippets/` and type-checked
 *      against the real SDK sources through `tsconfig.check.json` — the same
 *      mechanism `examples/**` already get, so a snippet that names a method,
 *      field or option the SDK does not ship fails the build. The one
 *      fence that drives a consumer's own express server still type-checks
 *      its SDK-facing calls (`webhooks.verifyAndParse`) against an ambient
 *      express shim; the shim stubs the server framework, never the SDK.
 *   2. **String-level agreement with nervly-docs** — the same shape
 *      `check-sdk-version.mjs` enforces on the portal side: the README's
 *      documented base URL, SDK version pins, Node floor and the
 *      "webhooks are not sent yet" warning must agree with what the
 *      committed portal content tells integrators (`content/quickstart.md`,
 *      `content/reference/sdk.md`, and the outbound-webhooks roadmap in
 *      `content/guides/delivery-receipts.md`).
 *
 * nervly-docs is a sibling checkout in CI (and locally). Without it the
 * agreement half skips loudly rather than failing a docs-only checkout — a
 * docs-only build is never what ships — while the type-level half still runs.
 *
 * Run: npm run check:readme
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const SNIPPET_DIR = join(ROOT, "docs", "readme-snippets");
const DOCS = join(ROOT, "..", "nervly-docs");

const findings = [];
const notes = [];

// ── 1. Extract and contract-check the README's TypeScript snippets ──────────

/**
 * Fences that are illustrative fragments rather than complete snippets.
 * Named, not pattern-matched away silently: the checker prints each skip, and
 * a skip whose reason outlives the README drifts into this list.
 */
const SKIPPED_FENCES = [
	{
		// The error-handling block shows only the shape of the catch:
		// `nervly.events.trigger({ /* ... */ })` passes a placeholder object
		// the real request schema would reject as incomplete.
		marker: "{ /* ... */ }",
		reason:
			"placeholder argument ({ /* ... */ }) — an illustrative catch, not a runnable call",
	},
];

const readme = readFileSync(README, "utf8");
const fences = [];
let inFence = false;
let fenceLang = "";
let fence = [];
for (const line of readme.split("\n")) {
	const open = line.match(/^```(\w*)/);
	if (open && !inFence) {
		inFence = true;
		fenceLang = (open[1] ?? "").toLowerCase();
		fence = [];
		continue;
	}
	if (inFence && /^```\s*$/.test(line)) {
		if (fenceLang === "typescript") fences.push(fence.join("\n"));
		inFence = false;
		fence = [];
		continue;
	}
	if (inFence) fence.push(line);
}

if (fences.length === 0) {
	findings.push(
		"README.md contains no typescript fences — the quickstart is not checked content",
	);
}

// `@nervly/sdk` resolves to the real sources through the paths mapping in
// tsconfig.check.json; snippets type-check against src/, not the built dist.
const NERVLY_CLIENT_DECL =
	"declare const nervly: import('@nervly/sdk').Nervly;\n";

const EXPRESS_SHIM = `// Ambient declaration for the README's webhook fence. The fence drives the
// consumer's own server; only its SDK-facing calls are contract-checked here.
declare module "express" {
	interface ExpressRequest {
		headers: Record<string, unknown>;
		body: Buffer;
	}
	interface ExpressResponse {
		status(code: number): { send(body?: unknown): void };
	}
	interface ExpressApp {
		post(
			path: string,
			...handlers: Array<(req: ExpressRequest, res: ExpressResponse) => unknown>
		): void;
	}
	function raw(
		options?: { type?: string },
	): (req: ExpressRequest, res: ExpressResponse) => void;
	const express: (() => ExpressApp) & { raw: typeof raw };
	export default express;
}
`;

mkdirSync(SNIPPET_DIR, { recursive: true });
writeFileSync(join(SNIPPET_DIR, "ambient.d.ts"), EXPRESS_SHIM);

let written = 0;
for (const [index, fenceBody] of fences.entries()) {
	const skipped = SKIPPED_FENCES.find((entry) =>
		fenceBody.includes(entry.marker),
	);
	if (skipped) {
		notes.push(`fence ${index + 1} skipped: ${skipped.reason}`);
		continue;
	}
	const declaresNervly =
		/new Nervly\b/.test(fenceBody) || /const nervly\s*=/.test(fenceBody);
	const usesNervly = /\bnervly\s*\./.test(fenceBody);
	const parts = [];
	if (!declaresNervly && usesNervly) parts.push(NERVLY_CLIENT_DECL);
	parts.push(fenceBody);
	// Fences without imports are scripts, and NodeNext forbids top-level
	// await in scripts; the empty export makes every extracted file an ESM
	// module so the README's await-at-the-top-level style type-checks as-is.
	parts.push("export {};\n");
	writeFileSync(
		join(SNIPPET_DIR, `snippet-${String(index + 1).padStart(2, "0")}.ts`),
		parts.join("\n"),
	);
	written += 1;
}

if (written === 0 && fences.length > 0) {
	findings.push(
		"every README typescript fence was skipped; no snippet is checked content",
	);
}

try {
	execFileSync("npx", ["tsc", "--project", "tsconfig.check.json"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	notes.push(
		`tsc --project tsconfig.check.json: ${written} README snippet(s) type-check against the SDK sources`,
	);
} catch (error) {
	const out = [error.stdout, error.stderr].filter(Boolean).join("\n");
	findings.push(
		"README snippets fail type-checking against the SDK (docs/readme-snippets/ kept for inspection):\n" +
			out
				.split("\n")
				.filter((line) => line.includes("snippet-"))
				.join("\n")
				.trim(),
	);
}

if (findings.length === 0) {
	// Clean run: remove the generated snippets so the tree stays pristine.
	rmSync(SNIPPET_DIR, { recursive: true, force: true });
}

// ── 2. String-level agreement with nervly-docs content ──────────────────────

function docsContent(relativePath) {
	const path = join(DOCS, relativePath);
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

const quickstart = docsContent("content/quickstart.md");
const sdkPage = docsContent("content/reference/sdk.md");
const deliveryReceipts = docsContent("content/guides/delivery-receipts.md");
const messageStatus = docsContent("content/guides/message-status.md");

if (sdkPage !== null) {
	// Base URL: the README's documented default must be the host the portal's
	// quickstart actually documents on the wire.
	const docsApiUrl = quickstart?.match(/https:\/\/[a-z0-9.-]+\/v1\//)?.[0];
	const readmeBaseUrl =
		readme.match(
			/\|\s*`baseUrl`\s*\|\s*`string`\s*\|\s*`(https?:\/\/[^`]+)`/,
		)?.[1] ?? readme.match(/(https:\/\/[a-z0-9.-]+)/)?.[1];
	if (!docsApiUrl || !readmeBaseUrl) {
		findings.push(
			"could not extract the documented base URL from the README and nervly-docs quickstart",
		);
	} else {
		const docsOrigin = new URL(docsApiUrl).origin;
		const readmeOrigin = new URL(readmeBaseUrl).origin;
		if (docsOrigin !== readmeOrigin) {
			findings.push(
				`README documents base URL ${readmeOrigin}, but the docs quickstart calls ${docsOrigin}`,
			);
		}
	}

	// SDK version: every pinned @nervly/sdk@x.y.z in either file must be the
	// version package.json ships (the README-side twin of check:sdk-version).
	const pkgVersion = JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf8"),
	).version;
	for (const [, text, file] of [
		["README", readme, "README.md"],
		["docs sdk reference", sdkPage, "content/reference/sdk.md"],
	]) {
		for (const match of text.matchAll(/@nervly\/sdk@(\d+\.\d+\.\d+)/g)) {
			if (match[1] !== pkgVersion) {
				findings.push(
					`${file} pins @nervly/sdk@${match[1]}, but the SDK ships ${pkgVersion}`,
				);
			}
		}
	}

	// Node floor: the README's stated Node requirement must agree with the
	// docs' compatibility claim.
	const readmeNode = Number(readme.match(/Node\s*(\d+)\+?/)?.[1]);
	const docsNode = Number(
		sdkPage.match(/Node\.js\s*(\d+)(?:\s+and later)?/)?.[1],
	);
	if (!readmeNode || !docsNode) {
		findings.push(
			"could not extract the documented Node floor from the README and nervly-docs sdk reference",
		);
	} else if (readmeNode !== docsNode) {
		findings.push(
			`README states Node ${readmeNode}+, but the docs say Node.js ${docsNode} and later`,
		);
	}
} else {
	notes.push(
		"docs agreement skipped: nervly-docs is not checked out next to nervly-js",
	);
}

// The outbound-webhook story must be true on both sides and tell one story.
// Since ticket 69 the hosted CLI relay/tunnel delivers real delivery events at
// v1, so the old blanket "Nervly does not send outbound delivery webhooks yet"
// wording is stale: **direct** outbound webhooks remain outside the launch
// surface (Month 6+), and both the README and the portal must name the
// launch-scope tunnel. When either side flips, this gate fails until both
// agree again.
if (!/does not send direct outbound delivery webhooks yet/.test(readme)) {
	findings.push(
		"README no longer carries the 'does not send direct outbound delivery webhooks yet' warning",
	);
}
if (!/nervly forward webhooks/.test(readme)) {
	findings.push(
		"README does not name the launch-scope CLI tunnel ('nervly forward webhooks'); the README and portal must tell one story about outbound delivery",
	);
}
if (deliveryReceipts !== null || messageStatus !== null) {
	const deferred = (text) =>
		text !== null && text.includes("not** part of the launch surface");
	const namesTunnel = (text) =>
		text !== null && text.includes("nervly forward webhooks");
	if (!deferred(deliveryReceipts) && !deferred(messageStatus)) {
		findings.push(
			"nervly-docs no longer documents direct outbound webhooks as outside the launch surface; the README's warning must be reconciled with it",
		);
	}
	if (!namesTunnel(deliveryReceipts) && !namesTunnel(messageStatus)) {
		findings.push(
			"nervly-docs no longer names the launch-scope CLI tunnel ('nervly forward webhooks'); the README's tunnel note must be reconciled with it",
		);
	}
}

// ── Report ───────────────────────────────────────────────────────────────────

for (const note of notes) console.log(`  ${note}`);

if (findings.length === 0) {
	console.log(
		"readme gate: every README snippet type-checks and the documented surface agrees with nervly-docs",
	);
	process.exit(0);
}

console.error(`readme gate: ${findings.length} finding(s)\n`);
for (const finding of findings) console.error(`  ${finding}`);
console.error(
	"\nUpdate README.md to match the SDK and the committed portal content.",
);
process.exit(1);
