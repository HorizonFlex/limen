import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// A host job runs in a worktree on another machine, so a seat path such as the scratch folder does not exist there.
// The coordinator names what the job reads with `--input`; Limen copies exactly that to the host, read-only for the
// job's purposes, and tells the job where it landed in LIMEN_INPUTS. Nothing is guessed from the task text.
// What the job writes under LIMEN_OUTPUTS comes back to `<job>/outputs` on the seat.
export const INPUTS_FILE = "inputs";
export const INPUTS_DIR = "inputs";
export const OUTPUTS_DIR = "outputs";
/** Inputs and outputs travel inside one ssh script, so they stay small. A job with more should read it from git. */
export const TRANSFER_CAP_BYTES = 32 * 1024 * 1024;

/** The absolute paths to copy, one per line in the job's `inputs` file. Refuses what cannot arrive intact. */
export async function validateInputs(
	requested: readonly string[],
	host: string | undefined,
	cwd: string,
): Promise<string[]> {
	if (requested.length === 0) {
		return [];
	}
	if (!host) {
		throw new Error("--input copies files to a host, so it needs --host");
	}
	const paths: string[] = [];
	const names = new Set<string>();
	let total = 0;
	for (const raw of requested) {
		const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
		if (!existsSync(path)) {
			throw new Error(`--input ${raw} does not exist`);
		}
		const name = basename(path);
		if (names.has(name)) {
			throw new Error(`--input names two paths called ${name}; each lands under that name, so rename one`);
		}
		names.add(name);
		total += await sizeOf(realpathSync(path));
		paths.push(path);
	}
	if (total > TRANSFER_CAP_BYTES) {
		throw new Error(
			`--input is ${Math.ceil(total / 1024 / 1024)} MB; the cap is ${TRANSFER_CAP_BYTES / 1024 / 1024} MB. Pass only what the job reads.`,
		);
	}
	return paths;
}

/** The recorded input paths of a job; empty when it has none. */
export function recordedInputs(jobDir: string): string[] {
	try {
		return readFileSync(join(jobDir, INPUTS_FILE), "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** One tar of every input, each stored under its own basename. Undefined when there is nothing to send. */
export function packInputs(paths: readonly string[]): Buffer | undefined {
	if (paths.length === 0) {
		return undefined;
	}
	// -h: the scratch folder itself is often a link to another disk; send what it points to.
	const args: string[] = ["-chf", "-"];
	for (const path of paths) {
		args.push("-C", dirname(path), basename(path));
	}
	const packed = spawnSync("tar", args, { maxBuffer: TRANSFER_CAP_BYTES * 2 });
	if (packed.status !== 0 || !packed.stdout) {
		throw new Error(`could not pack --input: ${packed.stderr?.toString().trim() || packed.status}`);
	}
	return Buffer.from(packed.stdout);
}

async function sizeOf(path: string): Promise<number> {
	const info = statSync(path);
	if (!info.isDirectory()) {
		return info.size;
	}
	let total = 0;
	for (const entry of await readdir(path)) {
		try {
			total += await sizeOf(join(path, entry));
		} catch {
			// A broken link inside the tree has no size and is sent as a link.
		}
	}
	return total;
}
