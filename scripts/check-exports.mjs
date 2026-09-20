#!/usr/bin/env node
/**
 * Proves the published package actually loads under both module systems.
 *
 * The packaging gates in `tests/api-stability.test.ts` read `package.json`; they
 * cannot see whether Node *resolves* the result. This script installs the
 * packed tarball into a scratch directory and then, once as ESM and once as
 * CommonJS, imports it and calls a real method — so both `exports` conditions
 * are exercised through the resolver a consumer would use, not through a
 * relative path into `dist/`.
 *
 * Requires `npm run build` first.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const build of ["dist/esm/index.js", "dist/cjs/index.js"]) {
	if (!existsSync(resolve(root, build))) {
		console.error(`  ${build} is missing. Run "npm run build" first.`);
		process.exit(1);
	}
}

const scratch = mkdtempSync(join(tmpdir(), "nervly-js-exports-"));

try {
	execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], {
		cwd: root,
		stdio: "inherit",
	});

	const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
	if (!tarball) {
		console.error("  npm pack produced no tarball");
		process.exit(1);
	}

	writeFileSync(
		join(scratch, "package.json"),
		`${JSON.stringify({ name: "nervly-js-exports-check", private: true, type: "module" }, null, 2)}\n`,
	);
	execFileSync(
		"npm",
		["install", "--silent", "--no-audit", "--no-fund", join(scratch, tarball)],
		{
			cwd: scratch,
			stdio: "inherit",
		},
	);

	// `import` — must resolve the ESM build.
	writeFileSync(
		join(scratch, "esm-consumer.mjs"),
		`import { fileURLToPath } from 'node:url';\n` +
			`import Nervly, { SDK_VERSION, AuthenticationError, NervlyAuthenticationError } from '@nervly/sdk';\n` +
			`if (typeof Nervly !== 'function') throw new Error('default export is not a class');\n` +
			`if (typeof SDK_VERSION !== 'string') throw new Error('SDK_VERSION missing');\n` +
			`if (AuthenticationError !== NervlyAuthenticationError) throw new Error('error alias mismatch');\n` +
			// Node supports `require(esm)` as of v22.12, so "it loaded" no longer
			// proves the CJS build was used. Assert on the *resolved path* instead.
			`const resolved = fileURLToPath(import.meta.resolve('@nervly/sdk'));\n` +
			`if (!resolved.includes('/dist/esm/')) throw new Error('import resolved to ' + resolved);\n` +
			`const client = new Nervly({ apiKey: 'nv_test_exports' });\n` +
			`if (typeof client.messages.list !== 'function') throw new Error('resources missing');\n` +
			`console.log('  import  → ESM build OK (v' + SDK_VERSION + ')');\n`,
	);

	// `require` — must resolve the CJS build.
	writeFileSync(
		join(scratch, "cjs-consumer.cjs"),
		`const Nervly = require('@nervly/sdk').default;\n` +
			`const { SDK_VERSION, RateLimitError, NervlyRateLimitError } = require('@nervly/sdk');\n` +
			`if (typeof Nervly !== 'function') throw new Error('default export is not a class');\n` +
			`if (typeof SDK_VERSION !== 'string') throw new Error('SDK_VERSION missing');\n` +
			`if (RateLimitError !== NervlyRateLimitError) throw new Error('error alias mismatch');\n` +
			// See the ESM consumer above: the resolved path is the real assertion.
			`const resolved = require.resolve('@nervly/sdk');\n` +
			`if (!resolved.includes('/dist/cjs/')) throw new Error('require resolved to ' + resolved);\n` +
			`const client = new Nervly({ apiKey: 'nv_test_exports' });\n` +
			`if (typeof client.email.send !== 'function') throw new Error('resources missing');\n` +
			`console.log('  require → CJS build OK (v' + SDK_VERSION + ')');\n`,
	);

	execFileSync(process.execPath, [join(scratch, "esm-consumer.mjs")], {
		stdio: "inherit",
	});
	execFileSync(process.execPath, [join(scratch, "cjs-consumer.cjs")], {
		stdio: "inherit",
	});

	// TypeScript consumers must also resolve, under `nodenext`, from both sides.
	writeFileSync(
		join(scratch, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					strict: true,
					noEmit: true,
					module: "nodenext",
					moduleResolution: "nodenext",
					target: "es2022",
					skipLibCheck: true,
				},
				include: ["consumer-types.mts", "consumer-types.cts"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(scratch, "consumer-types.mts"),
		`import Nervly, { AuthenticationError, type TriggerEventRequest } from '@nervly/sdk';\n` +
			`const nervly = new Nervly({ apiKey: 'k' });\n` +
			`const request: TriggerEventRequest = { name: 'x', to: { subscriberId: 's' } };\n` +
			`void nervly.events.trigger(request);\n` +
			`const err: unknown = new AuthenticationError();\n` +
			`if (err instanceof AuthenticationError) void err.statusCode;\n`,
	);
	writeFileSync(
		join(scratch, "consumer-types.cts"),
		`import Nervly = require('@nervly/sdk');\n` +
			`const nervly = new Nervly.Nervly({ apiKey: 'k' });\n` +
			`void nervly.messages.list();\n` +
			`const err: unknown = new Nervly.RateLimitError();\n` +
			`if (err instanceof Nervly.RateLimitError) void err.retryAfterMs;\n`,
	);

	execFileSync(
		process.execPath,
		[
			resolve(root, "node_modules/typescript/bin/tsc"),
			"--project",
			join(scratch, "tsconfig.json"),
		],
		{ cwd: scratch, stdio: "inherit" },
	);
	console.log("  tsc     → declarations resolve under nodenext (ESM + CJS)");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
