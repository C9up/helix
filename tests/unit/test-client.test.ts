import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestClient,
	type TestClient,
} from "../../src/http/TestClient.js";

/**
 * Spin up a tiny HTTP server so we test the TestClient against real
 * network behaviour (no mock of `@c9up/ream/testing` internals).
 */
describe("Helix TestClient", () => {
	let close: (() => Promise<void>) | undefined;
	let assignedPort = 0;

	const bootFn = async (): Promise<{
		port: number;
		close: () => Promise<void>;
	}> => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				const payload = Buffer.from(
					JSON.stringify({
						path: req.url,
						method: req.method,
						body,
						headers: req.headers,
					}),
				);
				// Force Content-Length so ream's raw-TCP parser (which doesn't
				// decode chunked transfer-encoding) returns the body verbatim.
				res.writeHead(200, {
					"content-type": "application/json",
					"content-length": payload.length,
					"x-echo-method": req.method ?? "",
					"x-echo-auth": req.headers.authorization ?? "",
				});
				res.end(payload);
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, resolve);
		});
		assignedPort = (server.address() as AddressInfo).port;
		const onClose = () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		return { port: assignedPort, close: onClose };
	};

	let client: TestClient;

	beforeAll(async () => {
		client = createTestClient(bootFn);
		await client.boot();
		close = () => client.close();
	});

	afterAll(async () => {
		await close?.();
	});

	it("get/post/put/patch/delete return RequestBuilder with the right verb", async () => {
		for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
			const res = await client[verb]("/ping").send();
			expect(res.status).toBe(200);
			expect(res.headers["x-echo-method"]?.toLowerCase()).toBe(verb);
		}
	});

	it("json body is echoed back", async () => {
		const response = await client.post("/echo").json({ hello: "world" }).send();
		expect(response.status).toBe(200);
		const payload = response.json<{ body: string }>();
		expect(JSON.parse(payload.body)).toEqual({ hello: "world" });
	});

	it("withAuth throws when no strategy was configured", async () => {
		await expect(client.get("/").withAuth({ id: "u1" }).send()).rejects.toThrow(
			/AuthStrategy/,
		);
	});

	it("withAuth injects headers when strategy is configured", async () => {
		const authed = createTestClient(bootFn, {
			auth: {
				headersFor: (subject: unknown) => {
					const id = (subject as { id: string }).id;
					return { authorization: `Bearer ${id}` };
				},
			},
		});
		await authed.boot();
		try {
			const builder = authed.get("/me").withAuth({ id: "alice" });
			await builder.expectStatus(200);
			await builder.expectHeader("x-echo-auth", "Bearer alice");
		} finally {
			await authed.close();
		}
	});
});
