import { describe, expect, it } from "vitest";
import { vi } from "../../../../src/runtime/vi/index.js";

describe("vi.spyOn", () => {
	it("replaces a method and calls through to the original", () => {
		const obj = {
			greet(name: string): string {
				return `hello ${name}`;
			},
		};
		const spy = vi.spyOn(obj, "greet");
		expect(obj.greet("world")).toBe("hello world");
		expect(spy.mock.calls).toEqual([["world"]]);
	});

	it("mockRestore reinstates the original method", () => {
		const obj = { fn: () => 1 };
		const spy = vi.spyOn(obj, "fn");
		spy.mockReturnValue(42);
		expect(obj.fn()).toBe(42);
		spy.mockRestore();
		expect(obj.fn()).toBe(1);
	});

	it("works on inherited methods (removes own shim on restore)", () => {
		class Base {
			hello(): string {
				return "base";
			}
		}
		const instance = new Base();
		const spy = vi.spyOn(instance, "hello");
		spy.mockReturnValue("overridden");
		expect(instance.hello()).toBe("overridden");
		spy.mockRestore();
		expect(Object.hasOwn(instance, "hello")).toBe(false);
		expect(instance.hello()).toBe("base");
	});

	it("throws when the property does not exist", () => {
		const obj: { nope?: () => void; a: number } = { a: 1 };
		expect(() => vi.spyOn(obj, "nope")).toThrow(/does not exist/);
	});

	it("throws when the property is not callable", () => {
		const obj = { count: 3 };
		expect(() => vi.spyOn(obj, "count")).toThrow(/not a function/);
	});

	it("can spy on a getter", () => {
		const obj = {
			_n: 10,
			get value(): number {
				return this._n;
			},
		};
		const spy = vi.spyOn(obj, "value", { accessor: "get" });
		expect(obj.value).toBe(10);
		expect(spy.mock.calls.length).toBe(1);
		spy.mockRestore();
		expect(obj.value).toBe(10);
	});
});
