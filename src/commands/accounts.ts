import { findStatusCommand, readAccountStatus } from "../runtime/account-status.ts";

/** `limen accounts`: which Claude account is active and which are spent, as the seat's own tool reports it. */
export async function accountsCommand(args: readonly string[]): Promise<void> {
	if (args.length > 0) {
		throw new Error("accounts takes no arguments");
	}
	const command = findStatusCommand();
	if (!command) {
		throw new Error(
			"no account status tool: put claude-account-rotate on PATH or in ~/seat/bin, or set LIMEN_ACCOUNT_STATUS to an executable that prints the report",
		);
	}
	const report = await readAccountStatus(command);
	if (!report.ok) {
		throw new Error(`account status failed: ${report.text}`);
	}
	console.log(report.text);
}
