/**
 * helix's `--files` rule, shared by `helix test` and any host driving helix
 * (ream's `ream test`), so a filter selects the same files from both.
 */

import path from "node:path";

/** Trailing `.test.ts` / `.spec.js` / … stripped, so `user` matches `user.test.ts`. */
const TEST_SUFFIX = /(\.(test|spec))?\.[cm]?[jt]sx?$/;

/**
 * Keep a file when its path ENDS WITH one of `filters`, or when every segment
 * of a filter (read right-to-left, `*` matching anything) matches the
 * corresponding path segment of the file minus its test suffix. `user` keeps
 * `tests/unit/user.test.ts`; `unit/*` keeps everything under a `unit`
 * directory. No filter, or an empty list, keeps every file.
 */
export function filterByFileFilters(
	files: readonly string[],
	filters: readonly string[] | undefined,
): string[] {
	const wanted = (filters ?? [])
		.map((filter) => filter.trim())
		.filter((filter) => filter.length > 0);
	if (wanted.length === 0) return [...files];
	return files.filter((file) => {
		const unix = file.split(path.sep).join("/");
		const fileSegments = unix.replace(TEST_SUFFIX, "").split("/").reverse();
		return wanted.some((filter) => {
			if (unix.endsWith(filter)) return true;
			return filter
				.split("/")
				.reverse()
				.every((segment, i) => {
					const fileSegment = fileSegments[i];
					return (
						fileSegment !== undefined &&
						(segment === "*" || fileSegment.endsWith(segment))
					);
				});
		});
	});
}
