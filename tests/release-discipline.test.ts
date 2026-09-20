/**
 * Release-discipline assertions (ticket 20).
 *
 * The scripts in `scripts/` are the gates CI runs; this suite is the independent
 * second reader. It asserts the artifacts those gates depend on are present and
 * internally consistent, using nothing but the filesystem, so a gate that is
 * accidentally loosened still trips a test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string =>
	readFileSync(resolve(ROOT, relative), "utf8");
const readJson = <T>(relative: string): T => JSON.parse(read(relative)) as T;

describe("npm release security", () => {
	const pkg = readJson<{
		version: string;
		files: string[];
		publishConfig: { access: string; provenance: boolean; registry: string };
	}>("package.json");

	it("declares provenance and public access in publishConfig", () => {
		assert.equal(pkg.publishConfig.provenance, true);
		assert.equal(pkg.publishConfig.access, "public");
		assert.match(pkg.publishConfig.registry, /registry\.npmjs\.org/);
	});

	it("ships the disclosure policy and changelog in the tarball", () => {
		assert.ok(pkg.files.includes("SECURITY.md"));
		assert.ok(pkg.files.includes("CHANGELOG.md"));
	});

	it("publishes from a tag-triggered workflow with provenance and an OIDC token", () => {
		const workflow = read(".github/workflows/release.yml");
		assert.match(workflow, /tags:\s*\n\s*-\s*'v\*'/);
		assert.match(workflow, /id-token:\s*write/);
		assert.match(workflow, /npm publish[^\n]*--provenance/);
		assert.match(workflow, /npm run audit/);
		assert.match(workflow, /npm run sbom/);
	});

	it("publishes a vulnerability disclosure policy with a contact", () => {
		const security = read("SECURITY.md");
		assert.match(security, /security@nervly\.io/);
		assert.match(security, /Reporting a vulnerability/i);
		assert.match(security, /Disclosure/i);
		assert.match(security, /Supported versions/i);
	});

	it("keeps the changelog entry and SDK_VERSION in step with the manifest", () => {
		const changelog = read("CHANGELOG.md");
		const versionSource = read("src/version.ts");
		assert.match(
			changelog,
			new RegExp(
				`## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`,
			),
		);
		assert.ok(versionSource.includes(`SDK_VERSION = "${pkg.version}"`));
	});
});

describe("version compatibility matrix", () => {
	it("maps the current SDK version to the committed gateway API version", () => {
		const pkg = readJson<{ version: string }>("package.json");
		const spec = readJson<{ info: { version: string } }>(
			"../nervly-docs/static/openapi/gateway.json",
		);
		const matrix = read("docs/version-compatibility.md");

		const row = matrix
			.split("\n")
			.filter((line) => line.trim().startsWith("|"))
			.map((line) =>
				line
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split("|")
					.map((cell) => cell.trim().replaceAll("`", "")),
			)
			.find((cells) => cells[0] === pkg.version);

		assert.ok(row, `matrix has a row for SDK ${pkg.version}`);
		assert.equal(
			row![1],
			spec.info.version,
			"matrix API version matches the spec",
		);
	});
});

describe("deprecation registry", () => {
	it("registers every symbol the source marks @deprecated", () => {
		const registry = readJson<{
			symbols: Array<{
				symbol: string;
				since: string;
				removeIn: string;
				replacement: string;
			}>;
		}>("deprecations.json");
		const sources = [
			read("src/resources/events.ts"),
			read("src/resources/subscribers.ts"),
		].join("\n");

		assert.ok(registry.symbols.length > 0);
		for (const entry of registry.symbols) {
			assert.ok(
				entry.since < entry.removeIn,
				`${entry.symbol} removal is after its deprecation`,
			);
			assert.match(
				sources,
				new RegExp(
					`@deprecated since ${entry.since.replace(/\./g, "\\.")}: use \`${entry.replacement}\`; removal in ${entry.removeIn.replace(/\./g, "\\.")}\\.`,
				),
				`${entry.symbol} carries its registered annotation`,
			);
		}
	});
});
