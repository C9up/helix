/**
 * Glob patterns for suite `files` entries.
 *
 * AdonisJS declares suites with real globs — its own defaults are
 * `tests/unit/**​/*.spec.(js|ts)` — so an `adonisrc.ts` suite list has to be
 * portable verbatim. This compiles the subset those patterns use (`*`, `**`,
 * `?`, `{a,b}`, `(a|b)`, `[abc]`) to a `RegExp` over root-relative POSIX paths.
 *
 * Not a general glob engine: no `!` negation and no extglob quantifiers
 * (`+(a)`, `@(a)`, …). An entry using one is reported rather than
 * half-honoured, so a pattern never silently selects the wrong set.
 */

const GLOB_CHARS = /[*?{}()[\]]/;

/** Whether an entry is a pattern rather than a plain path. */
export function isGlob(entry: string): boolean {
	return GLOB_CHARS.test(entry);
}

/** Extglob quantifiers — recognised only to be refused. */
const EXTGLOB = /[!+@]\(/;

/** The reason an entry cannot be compiled, or `undefined` when it can. */
export function globRejection(entry: string): string | undefined {
	if (entry.startsWith("!")) return "negation (`!`) is not supported";
	if (EXTGLOB.test(entry)) {
		return "extglob quantifiers (`+(…)`, `@(…)`, `!(…)`) are not supported";
	}
	return undefined;
}

/** Regex-escape one literal character. */
function escapeChar(char: string): string {
	return /[.+^$|\\]/.test(char) ? `\\${char}` : char;
}

/**
 * The leading path that contains no pattern character — the directory a walk
 * can start from. `tests/unit/**​/*.spec.ts` → `tests/unit`.
 */
export function globBaseDir(entry: string): string {
	const segments = entry.split("/");
	const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
	if (first === -1) return entry;
	return segments.slice(0, first).join("/") || ".";
}

/**
 * Compile a glob to an anchored `RegExp`. Paths are matched with `/`
 * separators, relative to the root the pattern was declared against.
 */
export function globToRegExp(entry: string): RegExp {
	let out = "";
	let depth = 0;
	let i = 0;
	while (i < entry.length) {
		const char = entry[i];
		if (char === "*") {
			if (entry[i + 1] === "*") {
				i += 2;
				// `**/` spans zero or more directories, so `tests/**​/*.ts` also
				// matches `tests/a.ts` — the globstar semantics Adonis relies on.
				if (entry[i] === "/") {
					out += "(?:[^/]*/)*";
					i += 1;
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
				i += 1;
			}
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (char === "{" || char === "(") {
			out += "(?:";
			depth += 1;
			i += 1;
			continue;
		}
		if ((char === "}" || char === ")") && depth > 0) {
			out += ")";
			depth -= 1;
			i += 1;
			continue;
		}
		if ((char === "," || char === "|") && depth > 0) {
			out += "|";
			i += 1;
			continue;
		}
		if (char === "[") {
			const close = entry.indexOf("]", i + 1);
			if (close !== -1) {
				const body = entry.slice(i + 1, close);
				out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
				i = close + 1;
				continue;
			}
		}
		out += escapeChar(char);
		i += 1;
	}
	return new RegExp(`^${out}$`);
}
