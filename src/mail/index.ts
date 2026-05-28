/**
 * `@c9up/helix/mail` — facade for in-memory mail-transport fakes.
 *
 * Helix is agnostic — no `@c9up/rover` import. The caller passes
 * the `FakeMail` class to `mail.fake(...)` at runtime; helix
 * duck-types its surface (`MailFakeLike`) and orchestrates the
 * lifecycle.
 *
 *   import { FakeMail } from "@c9up/rover/testing";
 *   import { mail, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   mail.fake(FakeMail);
 *   // ...
 *   mail.assertSent({ to: "user@x.com", subject: "Welcome" });
 */

export type { MailFakeCtor, MailFakeLike, MailFakeOptions } from "./fake.js";
export {
	assertNotSent,
	assertSent,
	current,
	fake,
	getSent,
	reset,
} from "./fake.js";
