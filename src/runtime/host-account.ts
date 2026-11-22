import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUsable, leastLoaded, readSeatUsage, type Usage } from "./account-usage.ts";
import { listSeatAccounts } from "./claude-account.ts";

// A host job bills the account the coordinator names. Without `--account` it bills the seat's active account.
// `--account auto` picks the account with the most room at spawn time. The choice is recorded as a name in the job
// folder, so a later start or continue bills the same account; the token is read again from the seat each time.
export const ACCOUNT_FILE = "account";
export const AUTO_ACCOUNT = "auto";

/** The account name to record for this job, or undefined for the seat's active account. Refuses what cannot work. */
export async function chooseHostAccount(
	requested: string | undefined,
	host: string | undefined,
	probe: () => Promise<Usage[]> = () => readSeatUsage(),
): Promise<string | undefined> {
	if (requested === undefined) {
		return undefined;
	}
	if (!host) {
		throw new Error("--account chooses the account a host job bills, so it needs --host");
	}
	if (requested === AUTO_ACCOUNT) {
		const best = leastLoaded(await probe());
		if (!best) {
			throw new Error("--account auto: no seat account has quota left right now; see limen accounts");
		}
		return best.name;
	}
	const known = listSeatAccounts();
	const match = known.find((entry) => entry.name === requested || entry.aliases.includes(requested));
	if (!match) {
		const names = known.map((entry) => entry.name).join(", ") || "none";
		throw new Error(`--account ${requested}: no such seat account (have: ${names})`);
	}
	const row = (await probe()).find((entry) => entry.name === match.name);
	if (row && !isUsable(row) && row.error === undefined) {
		throw new Error(`--account ${requested} has no quota left right now; see limen accounts or use --account auto`);
	}
	return match.name;
}

/** The account recorded for a job, or undefined when it uses the active one. */
export function recordedAccount(jobDir: string): string | undefined {
	try {
		return readFileSync(join(jobDir, ACCOUNT_FILE), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
