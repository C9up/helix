/**
 * Glob patterns for suite `files` entries.
 *
 * AdonisJS declares suites with real globs — its own defaults are
 * `tests/unit/**​/*.spec.(js|ts)` — so an `adonisrc.ts` suite list has to be
 * portable verbatim. Compiles to a `RegExp` over root-relative POSIX paths:
 * `*`, `**`, `?`, `{a,b}`, `(a|b)`, `[abc]`, and the extglob quantifiers with an
 * exact regex equivalent — `@(a|b)`, `?(a|b)`, `*(a|b)`, `+(a|b)`.
 *
 * An ENTRY may also start with `!` to exclude what it matches from the suite,
 * the way a file list is usually written.
 *
 * One form stays refused: `!(a|b)`, the negated extglob GROUP. Its semantics
 * ("anything in this segment other than a or b", composing with whatever
 * follows) have no faithful regex rendering, and a near-miss would silently
 * select the wrong files — the one thing a file selector must not do.
 */

const GLOB_CHARS = /[*?{}()[\]]/;

/** Whether an entry is a pattern rather than a plain path. */
export function isGlob(entry: string): boolean {
	return GLOB_CHARS.test(entry);
}

/** The negated extglob group, the one form with no exact regex equivalent. */
const NEGATED_GROUP = /!\(/;

/** Whether an entry excludes rather than selects (a leading `!`). */
export function isNegated(entry: string): boolean {
	return entry.startsWith("!") && !entry.startsWith("!(");
}

/** The pattern an entry carries, with any leading `!` stripped. */
export function withoutNegation(entry: string): string {
	return isNegated(entry) ? entry.slice(1) : entry;
}

/** The reason an entry cannot be compiled, or `undefined` when it can. */
export function globRejection(entry: string): string | undefined {
	if (NEGATED_GROUP.test(entry)) {
		return "the negated extglob group `!(…)` is not supported — write a `!pattern` entry to exclude";
	}
	return undefined;
}

/** The regex quantifier an extglob prefix stands for. */
function quantifierFor(prefix: string): string {
	if (prefix === "?") return "?";
	if (prefix === "*") return "*";
	if (prefix === "+") return "+";
	return "";
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
		// `@(a|b)`, `?(a|b)`, `*(a|b)`, `+(a|b)` — the prefix quantifies the group
		// rather than standing on its own, so it is consumed here before the `*`
		// and `?` cases could claim it.
		if (
			(char === "@" || char === "?" || char === "*" || char === "+") &&
			entry[i + 1] === "("
		) {
			const close = matchingParen(entry, i + 1);
			if (close !== -1) {
				out += `(?:${bodyToRegExp(entry.slice(i + 2, close))})${quantifierFor(char)}`;
				i = close + 1;
				continue;
			}
		}
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
	try {
		return new RegExp(`^${out}$`);
	} catch (cause) {
		// An unbalanced `{`, `(` or `[` compiles to an unbalanced regex. Raw, the
		// failure reads as an internal regex the author never wrote — name their
		// pattern instead, since that is what they have to fix.
		throw new Error(
			`Cannot read "${entry}" as a glob pattern — check that every {, ( and [ is closed.`,
			{ cause },
		);
	}
}

/** Index of the `)` closing the `(` at `open`, or `-1` when unbalanced. */
function matchingParen(entry: string, open: number): number {
	let depth = 0;
	for (let i = open; i < entry.length; i += 1) {
		if (entry[i] === "(") depth += 1;
		else if (entry[i] === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Compile a quantified group's body. Each alternative is a pattern in its own
 * right, so `@(a|b)` and `@(a,b)` both read as "a or b" — the two separators
 * glob syntax uses for the same thing.
 */
function bodyToRegExp(body: string): string {
	return splitAlternatives(body)
		.map((alternative) => globToRegExp(alternative).source.slice(1, -1))
		.join("|");
}

/** Split a group body on its TOP-LEVEL separators, so nesting survives. */
function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i += 1) {
		const char = body[i];
		if (char === "(" || char === "{" || char === "[") depth += 1;
		else if (char === ")" || char === "}" || char === "]") depth -= 1;
		else if ((char === "|" || char === ",") && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}
