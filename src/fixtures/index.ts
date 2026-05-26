/**
 * Sub-barrel for `helix.fixture`. Reach via the namespace export:
 *
 *     import { fixture } from "@c9up/helix"
 *     fixture.define("user", () => factory(User, defaults))
 */
export {
	clear,
	create,
	createMany,
	currentDatabase,
	define,
	make,
	makeStubbed,
	names,
	useDatabase,
	useTransactional,
} from "./Fixture.js";
