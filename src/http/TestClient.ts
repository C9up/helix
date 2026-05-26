import { TestClient as ReamTestClient } from "@c9up/ream/testing";
import {
	type AuthStrategy,
	type HttpMethod,
	type HttpSender,
	RequestBuilder,
} from "./RequestBuilder.js";

/**
 * App boot contract — any callable that starts an HTTP app on the given
 * port and returns a port+close pair. Matches `@c9up/ream/testing`
 * TestClient's expectation so existing apps plug in unchanged.
 */
export type AppBootFn = (
	port: number,
) => Promise<{ port: number; close: () => Promise<void> | void }>;

export interface HelixClientOptions {
	/**
	 * Auth strategy used by `builder.withAuth(user)` / `.asUser(id)`. Typically
	 * derived from Warden's active strategy (JWT / session / API key).
	 * Without this option, `.withAuth()` throws at send time.
	 */
	auth?: AuthStrategy;
}

/**
 * Helix HTTP TestClient. Thin wrapper around `@c9up/ream/testing`'s
 * TestClient that exposes the fluent `request()` API from Story 42-2 plus
 * per-builder auth injection.
 */
export class TestClient {
	#inner: ReamTestClient;
	#auth: AuthStrategy | null;

	constructor(bootFn: AppBootFn, options: HelixClientOptions = {}) {
		this.#inner = new ReamTestClient(bootFn);
		this.#auth = options.auth ?? null;
	}

	async boot(): Promise<void> {
		await this.#inner.boot();
	}

	async close(): Promise<void> {
		await this.#inner.close();
	}

	/**
	 * Ephemeral port the underlying server bound to. Forward of
	 * `ReamTestClient.port`; use for SSE / WebSocket tests that need a
	 * raw `fetch` (the fluent surface buffers responses fully).
	 */
	get port(): number {
		return this.#inner.port;
	}

	/** Build a request with the full fluent+assertion surface. */
	request(method: HttpMethod, path: string): RequestBuilder {
		return new RequestBuilder(this.#sender, method, path, this.#auth);
	}

	get(path: string): RequestBuilder {
		return this.request("GET", path);
	}
	post(path: string): RequestBuilder {
		return this.request("POST", path);
	}
	put(path: string): RequestBuilder {
		return this.request("PUT", path);
	}
	patch(path: string): RequestBuilder {
		return this.request("PATCH", path);
	}
	delete(path: string): RequestBuilder {
		return this.request("DELETE", path);
	}

	/** Adapter: route the builder's send through the inner TestClient. */
	#sender: HttpSender = async (method, path, init) => {
		const req = this.#inner.request(method, path);
		for (const [k, v] of Object.entries(init.headers)) {
			req.header(k, v);
		}
		if (init.body.length > 0) {
			const contentType =
				init.headers["content-type"] ?? "application/octet-stream";
			// ReamTestClient#body accepts string only; tests-side bodies are
			// JSON / form-urlencoded / text in practice. Binary payloads can
			// be supplied as a pre-encoded string by the caller.
			req.body(init.body.toString("utf8"), contentType);
		}
		return req.send();
	};
}

/**
 * Entry point matching the Adonis test_utils convention:
 *
 *   const client = helix.http.request(app)
 *   await client.boot()
 *   await client.get('/health').expectStatus(200)
 *   await client.close()
 */
export function createTestClient(
	bootFn: AppBootFn,
	options?: HelixClientOptions,
): TestClient {
	return new TestClient(bootFn, options);
}

export type { TestResponse } from "@c9up/ream/testing";
export type {
	AuthStrategy,
	AuthSubject,
	HttpMethod,
	HttpSender,
} from "./RequestBuilder.js";
export { RequestBuilder } from "./RequestBuilder.js";
