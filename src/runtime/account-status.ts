import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// The seat keeps Claude accounts and swaps the active one when a quota is spent. A quota message names the reset of the
// account that failed, which may no longer be the active one. Limen does not track accounts itself; it asks whatever
// the seat uses and shows the answer, so a coordinator does not wait on a reset that no longer applies.
const ROTATOR = "claude-account-rotate";
const TIMEOUT_MS = 20_000;

export type StatusCommand = { readonly file: string; readonly args: readonly string[] };

/**
 * The command that reports account state. `LIMEN_ACCOUNT_STATUS` names an executable that prints a report and takes no
 * arguments, and when set it is the only source. Otherwise the seat rotator is looked up on PATH, then in `~/seat/bin`.
 */
export function findStatusCommand(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): StatusCommand | undefined {
	const forced = env.LIMEN_ACCOUNT_STATUS?.trim();
	if (forced) {
		return isAbsolute(forced) && runnable(forced) ? { file: forced, args: [] } : undefined;
	}
	const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, "seat", "bin")];
	for (const dir of dirs) {
		const file = join(dir, ROTATOR);
		if (runnable(file)) {
			return { file, args: ["status"] };
		}
	}
	return undefined;
}

/** The report text, or the reason it could not be read. The report is passed through as the tool wrote it. */
export async function readAccountStatus(
	command: StatusCommand,
): Promise<{ readonly ok: boolean; readonly text: string }> {
	return await new Promise((resolve) => {
		execFile(
			command.file,
			[...command.args],
			{ timeout: TIMEOUT_MS, maxBuffer: 1_000_000 },
			(error, stdout, stderr) => {
				const text = `${stdout}${stderr}`.trim();
				resolve(error ? { ok: false, text: text || error.message } : { ok: true, text });
			},
		);
	});
}

function runnable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
