/**
 * Secret redaction for the mcp-agent harness.
 *
 * Every transcript line and every artifact payload passes through {@link redact}
 * at the output boundary, so a secret that leaks into a log message or a summary
 * detail is scrubbed before it reaches stdout or disk. The contract's release
 * gate is `grep -R "nervly_sk_test_" <repo>/artifacts` finding nothing, so the
 * replacement text deliberately does not contain the key prefix.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	// API keys, test or live (replace the whole token, prefix included).
	[/nervly_sk_(?:test|live)_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]"],
	// Session and CSRF cookie pairs (`Cookie:` headers and Set-Cookie strings).
	[/(nervly_session=)[^;\s"']+/g, "$1[REDACTED]"],
	[/(nervly_csrf=)[^;\s"']+/g, "$1[REDACTED]"],
	// Email-verification links (`?token=<64 hex>`).
	[/(token=)[a-f0-9]{64}/gi, "$1[REDACTED]"],
	// Sensitive JSON fields anywhere in an artifact or log payload.
	[
		/("(?:api_key|apiKey|token|password|csrf_token|session)"\s*:\s*")[^"]*"/g,
		'$1[REDACTED]"',
	],
];

/** Redact every known secret shape from `input`. */
export function redact(input: string): string {
	let output = input;
	for (const [pattern, replacement] of PATTERNS) {
		output = output.replace(pattern, replacement);
	}
	return output;
}

/**
 * Redact a JSON-serializable value by serializing, scrubbing and parsing back.
 * Used for artifact payloads (e.g. `bootstrap.json`) so a secret cannot be
 * written by accident even if a caller hands the raw object here.
 */
export function redactValue<T>(value: T): T {
	return JSON.parse(redact(JSON.stringify(value))) as T;
}
