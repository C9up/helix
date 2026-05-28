import {
	type AppBootFn,
	createTestClient,
	type HelixClientOptions,
} from "./TestClient.js";

export {
	type AuthStrategy,
	type AuthSubject,
	type HttpMethod,
	type HttpSender,
	partialMatch,
	RequestBuilder,
} from "./RequestBuilder.js";
export {
	type AppBootFn,
	createTestClient,
	type HelixClientOptions,
	TestClient,
	type TestResponse,
} from "./TestClient.js";

/**
 * Shortcut matching the Adonis convention:
 *
 *   import { http } from '@c9up/helix'
 *   const client = http.request(() => myApp.boot())
 */
export const http = {
	request: (boot: AppBootFn, options?: HelixClientOptions) =>
		createTestClient(boot, options),
};
