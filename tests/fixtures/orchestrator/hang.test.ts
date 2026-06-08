import { test } from "../../../src/runtime/index.js";

test("hangs forever", () => new Promise<void>(() => {}));
