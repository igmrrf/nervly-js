/**
 * workerd entry point (`wrangler.jsonc` `main`). It must export **only** the
 * default handler — workerd rejects additional non-handler exports on the entry
 * module — so the routes live in `app.ts` where tests can import them.
 */

import { handleRequest, type WorkerEnv } from "./app.js";

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		return handleRequest(request, env);
	},
};
