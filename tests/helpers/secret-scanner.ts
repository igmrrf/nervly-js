/**
 * Shared secret scanner for the no-secrets test.
 *
 * Factored out of the test so the mutation/self-test asserts on the same code
 * path that scans the published package — an independent copy of the regexes
 * could keep passing while the real scan silently broke.
 *
 * Findings report a class + offset, never the matched bytes, so a failing run
 * does not itself print the credential it found.
 */

export interface SecretFinding {
	/** Human-readable class of secret, e.g. "AWS access key id". */
	name: string;
	/** Character offset of the match within the scanned text. */
	index: number;
}

interface SecretPattern {
	name: string;
	pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		name: "PEM private key header",
		pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
	},
	{ name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "GitHub token", pattern: /\b(?:ghp|gho|ghr|ghs)_[A-Za-z0-9]{20,}\b/ },
	{
		name: "GitHub fine-grained PAT",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	},
	{ name: "Stripe live secret key", pattern: /\bsk_live_[A-Za-z0-9]{10,}\b/ },
	{ name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{
		name: "DSN with inline password",
		pattern:
			/\b(?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|mysql|amqp(?:s)?):\/\/[^\s:/@]+:[^\s@/]+@/,
	},
	{ name: "Bearer token literal", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

export function findSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const { name, pattern } of SECRET_PATTERNS) {
		const flags = pattern.flags.includes("g")
			? pattern.flags
			: `${pattern.flags}g`;
		const re = new RegExp(pattern.source, flags);
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard sticky-regex exec loop
		while ((match = re.exec(text)) !== null) {
			findings.push({ name, index: match.index });
			if (match.index === re.lastIndex) re.lastIndex += 1;
		}
	}
	return findings;
}
