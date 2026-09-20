import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Nervly } from "../src/index.js";

describe("Event Trigger Schema OpenAPI Contract Test", () => {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const openApiPath = resolve(
		currentDir,
		"../../nervly-docs/static/openapi/gateway.json",
	);
	const specContent = readFileSync(openApiPath, "utf-8");
	const openApiSpec = JSON.parse(specContent) as {
		components: {
			schemas: Record<
				string,
				{
					type?: string;
					properties?: Record<string, unknown>;
					required?: string[];
				}
			>;
		};
	};

	const schemas = openApiSpec.components.schemas;

	it("OpenAPI schema must declare EmailOverrideDto with sender and provider", () => {
		const emailOverride = schemas["EmailOverrideDto"];
		assert.ok(
			emailOverride,
			"EmailOverrideDto schema must be present in OpenAPI spec",
		);
		assert.ok(
			emailOverride.properties,
			"EmailOverrideDto must have properties",
		);

		const expectedProperties = ["sender", "provider", "customHeaders"];
		for (const prop of expectedProperties) {
			assert.ok(
				prop in emailOverride.properties,
				`EmailOverrideDto in OpenAPI spec missing expected property: ${prop}`,
			);
		}
	});

	it("OpenAPI schema must declare ProviderOverridesDto with email, whatsapp, sms, voice, and extraParams", () => {
		const providerOverrides = schemas["ProviderOverridesDto"];
		assert.ok(
			providerOverrides,
			"ProviderOverridesDto schema must be present in OpenAPI spec",
		);
		assert.ok(
			providerOverrides.properties,
			"ProviderOverridesDto must have properties",
		);

		const expectedProperties = [
			"email",
			"whatsapp",
			"sms",
			"voice",
			"extraParams",
		];
		for (const prop of expectedProperties) {
			assert.ok(
				prop in providerOverrides.properties,
				`ProviderOverridesDto in OpenAPI spec missing expected property: ${prop}`,
			);
		}
	});

	it("OpenAPI schema must declare VoiceOverrideDto with script, voice_id, and language", () => {
		const voiceOverride = schemas["VoiceOverrideDto"];
		assert.ok(
			voiceOverride,
			"VoiceOverrideDto schema must be present in OpenAPI spec",
		);
		assert.ok(
			voiceOverride.properties,
			"VoiceOverrideDto must have properties",
		);

		const expectedProperties = ["script", "voice_id", "language"];
		for (const prop of expectedProperties) {
			assert.ok(
				prop in voiceOverride.properties,
				`VoiceOverrideDto in OpenAPI spec missing expected property: ${prop}`,
			);
		}
	});

	it("OpenAPI schema must declare TriggerRequest with name, to, payload, overrides, and category", () => {
		const triggerRequest = schemas["TriggerRequest"];
		assert.ok(
			triggerRequest,
			"TriggerRequest schema must be present in OpenAPI spec",
		);
		assert.ok(triggerRequest.properties, "TriggerRequest must have properties");

		const expectedProperties = [
			"name",
			"to",
			"payload",
			"overrides",
			"category",
		];
		for (const prop of expectedProperties) {
			assert.ok(
				prop in triggerRequest.properties,
				`TriggerRequest in OpenAPI spec missing expected property: ${prop}`,
			);
		}
	});

	it("built SDK email payload strictly conforms to OpenAPI TriggerRequest schema", () => {
		const nervly = new Nervly({ apiKey: "nv_live_contract_test" });
		const payload = nervly.email.buildTriggerRequest({
			to: { subscriberId: "sub_test_1", email: "test@nervly.io" },
			subject: "Contract Test",
			html: "<p>Contract test html</p>",
			provider: "resend",
			sender: "Nervly <test@nervly.io>",
			category: "notifications",
		});

		const triggerProperties = Object.keys(
			schemas["TriggerRequest"]?.properties || {},
		);
		for (const key of Object.keys(payload)) {
			assert.ok(
				triggerProperties.includes(key),
				`Generated payload property '${key}' does not exist in OpenAPI TriggerRequest schema`,
			);
		}

		const emailOverrideProperties = Object.keys(
			schemas["EmailOverrideDto"]?.properties || {},
		);
		if (payload.overrides?.email) {
			for (const key of Object.keys(payload.overrides.email)) {
				assert.ok(
					emailOverrideProperties.includes(key),
					`Generated email override property '${key}' does not exist in OpenAPI EmailOverrideDto schema`,
				);
			}
		}
	});

	it("built SDK voice payload strictly conforms to OpenAPI TriggerRequest and VoiceOverrideDto schemas", () => {
		const nervly = new Nervly({ apiKey: "nv_live_contract_test" });
		const payload = nervly.voice.buildTriggerRequest({
			to: { subscriberId: "sub_voice_1", phone: "+2348012345678" },
			script: "Your verification code is 4827",
			voice_id: "Ada",
			language: "en-US",
		});

		const triggerProperties = Object.keys(
			schemas["TriggerRequest"]?.properties || {},
		);
		for (const key of Object.keys(payload)) {
			assert.ok(
				triggerProperties.includes(key),
				`Generated voice payload property '${key}' does not exist in OpenAPI TriggerRequest schema`,
			);
		}

		// The typed opt-in must actually be emitted. Without these assertions the
		// key loop below would no-op on an absent `overrides.voice` and the test
		// would pass even if the SDK stopped emitting voice.
		assert.ok(
			payload.overrides,
			"voice payload must carry an overrides object",
		);
		assert.ok(
			payload.overrides.voice,
			"voice payload must carry overrides.voice (the typed voice opt-in)",
		);
		assert.deepEqual(
			payload.overrides.voice,
			{
				script: "Your verification code is 4827",
				voice_id: "Ada",
				language: "en-US",
			},
			"overrides.voice must carry the typed script, voice_id and language",
		);

		const providerOverrideProperties = Object.keys(
			schemas["ProviderOverridesDto"]?.properties || {},
		);
		assert.ok(
			providerOverrideProperties.includes("voice"),
			"ProviderOverridesDto in OpenAPI spec must declare the voice property",
		);

		const voiceOverrideProperties = Object.keys(
			schemas["VoiceOverrideDto"]?.properties || {},
		);
		const voiceKeys = Object.keys(payload.overrides.voice);
		assert.ok(voiceKeys.length > 0, "overrides.voice must not be empty");
		for (const key of voiceKeys) {
			assert.ok(
				voiceOverrideProperties.includes(key),
				`Generated voice override property '${key}' does not exist in OpenAPI VoiceOverrideDto schema`,
			);
		}
	});
});
