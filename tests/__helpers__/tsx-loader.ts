import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * The `tsx` ESM loader, as a URL to pass to `node --import`.
 *
 * The integration suites spawn a worker that has to load a `.ts` fixture, so
 * they need the loader's path. Node's own resolver finds it wherever this
 * package is installed — the earlier version scanned four directories up for
 * pnpm's virtual store, which exists in this workspace and nowhere else, so
 * every one of those suites ran the worker with no loader (and read the
 * result as "the orchestrator returned nothing") in helix's own repository.
 */
export function resolveTsxLoader(): string | undefined {
	try {
		return pathToFileURL(
			createRequire(import.meta.url).resolve("tsx"),
		).toString();
	} catch {
		return undefined;
	}
}
