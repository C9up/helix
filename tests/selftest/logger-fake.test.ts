/**
 * Self-test: `helix.logger.fake` end-to-end through the helix
 * runtime. Helix is agnostic — no `@c9up/spectrum` import.
 */

import {
	afterEach,
	clearActiveContainer,
	describe,
	expect,
	logger,
	test,
	useContainer,
} from "@c9up/helix";
import { Container } from "@c9up/ream";

class StubFakeLogger {
	captured: Array<{ level: string; message: string }> = [];
	write(entry: unknown): void {
		this.captured.push(entry as { level: string; message: string });
	}
	getLogged(): unknown[] {
		return this.captured.slice();
	}
	reset(): void {
		this.captured = [];
	}
	assertLogged(level: string): void {
		if (!this.captured.some((e) => e.level === level)) {
			throw new Error(`assertLogged failed: ${level}`);
		}
	}
	assertNotLogged(level: string): void {
		if (this.captured.some((e) => e.level === level)) {
			throw new Error(`assertNotLogged failed: ${level}`);
		}
	}
}

describe("helix.logger.fake — end-to-end", () => {
	afterEach(() => clearActiveContainer());

	test("fake + assertLogged works under the helix runtime", () => {
		const c = new Container();
		c.singleton("logger", () => ({ real: true }));
		useContainer(c);
		const f = logger.fake(StubFakeLogger);
		f.write({ level: "error", message: "boom" });
		logger.assertLogged("error");
		expect(logger.getLogged()).toHaveLength(1);
	});
});

describe("helix.logger — auto-clear between tests", () => {
	test("test A registers a fake and never clears it", () => {
		const c = new Container();
		c.singleton("logger", () => ({ real: true }));
		useContainer(c);
		logger.fake(StubFakeLogger);
		expect(logger.current()).not.toBeNull();
	});

	test("test B sees no active fake (auto-cleared after test A)", () => {
		expect(logger.current()).toBeNull();
	});
});
