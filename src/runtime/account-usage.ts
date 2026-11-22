import { listSeatAccounts } from "./claude-account.ts";

// How full each account's quota is. The API answers every call with its current five-hour and weekly utilization in
// response headers, a rejected call included, so one call of a single token per account reads it. That needs no scope
// beyond the one a seat token already has. The probe costs one output token per account.
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5";
const PROBE_TIMEOUT_MS = 20_000;
// An OAuth token is accepted only with this system line.
const SYSTEM_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";

export type Usage = {
	readonly name: string;
	readonly aliases: readonly string[];
	/** Fractions from 0 to 1, absent when the answer carried no quota headers. */
	readonly fiveHour?: number;
	readonly sevenDay?: number;
	/** Epoch seconds. */
	readonly fiveHourReset?: number;
	readonly sevenDayReset?: number;
	/** `allowed`, `rejected`, … as the API names it. */
	readonly status?: string;
	readonly error?: string;
	/** Another account whose windows match this one's exactly: two tokens on one subscription share one limit. */
	readonly sameLimitAs?: string;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Reads usage for one token. Never throws and never carries the token in its result. */
export async function probeUsage(
	token: string,
	env: NodeJS.ProcessEnv = process.env,
	fetcher: Fetch = fetch,
): Promise<Omit<Usage, "name" | "aliases">> {
	let response: Response;
	try {
		response = await fetcher(env.LIMEN_USAGE_URL?.trim() || DEFAULT_URL, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: env.LIMEN_USAGE_MODEL?.trim() || DEFAULT_MODEL,
				max_tokens: 1,
				system: SYSTEM_LINE,
				messages: [{ role: "user", content: "." }],
			}),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return { error: error instanceof Error ? error.name : "request failed" };
	}
	await response.body?.cancel().catch(() => {});
	return readUsageHeaders(response.headers, response.status);
}

export function readUsageHeaders(headers: Headers, httpStatus: number): Omit<Usage, "name" | "aliases"> {
	const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`) ?? undefined;
	const number = (value: string | undefined) => {
		const parsed = value === undefined ? Number.NaN : Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const fiveHour = number(get("5h-utilization"));
	const sevenDay = number(get("7d-utilization"));
	if (fiveHour === undefined && sevenDay === undefined) {
		return { error: `http ${httpStatus}` };
	}
	const fiveHourReset = number(get("5h-reset"));
	const sevenDayReset = number(get("7d-reset"));
	const status = get("status");
	return {
		...(fiveHour !== undefined ? { fiveHour } : {}),
		...(sevenDay !== undefined ? { sevenDay } : {}),
		...(fiveHourReset !== undefined ? { fiveHourReset } : {}),
		...(sevenDayReset !== undefined ? { sevenDayReset } : {}),
		...(status ? { status } : {}),
	};
}

/** Usage of every seat account, probed in parallel. */
export async function readSeatUsage(
	root?: string,
	env: NodeJS.ProcessEnv = process.env,
	fetcher: Fetch = fetch,
): Promise<Usage[]> {
	const accounts = listSeatAccounts(root);
	const rows = await Promise.all(
		accounts.map(async (account) => ({
			name: account.name,
			aliases: account.aliases,
			...(await probeUsage(account.token, env, fetcher)),
		})),
	);
	return markSharedLimits(rows);
}

/**
 * Tokens are not subscriptions: two different tokens of one subscription report the same windows. Accounts whose
 * five-hour and weekly resets are identical and whose weekly share is within a point are marked as sharing one limit,
 * so nobody counts that room twice. Each is marked against the first account (by order) it matches.
 */
export function markSharedLimits(rows: readonly Usage[]): Usage[] {
	return rows.map((row, index) => {
		if (row.fiveHourReset === undefined || row.sevenDayReset === undefined || row.sevenDay === undefined) {
			return row;
		}
		const first = rows
			.slice(0, index)
			.find(
				(other) =>
					other.fiveHourReset === row.fiveHourReset &&
					other.sevenDayReset === row.sevenDayReset &&
					other.sevenDay !== undefined &&
					Math.abs(other.sevenDay - (row.sevenDay ?? 0)) <= 0.01,
			);
		return first ? { ...row, sameLimitAs: first.name } : row;
	});
}

/** An account that has quota left right now. */
export function isUsable(usage: Usage): boolean {
	return (
		usage.error === undefined && usage.status !== "rejected" && (usage.fiveHour ?? 0) < 1 && (usage.sevenDay ?? 0) < 1
	);
}

/**
 * The usable account with the most room: the one whose fuller window is emptiest, so neither the five-hour nor the
 * weekly allowance runs out first. Ties go to the lower name.
 */
export function leastLoaded(rows: readonly Usage[]): Usage | undefined {
	const load = (row: Usage) => Math.max(row.fiveHour ?? 0, row.sevenDay ?? 0);
	return rows.filter(isUsable).sort((a, b) => load(a) - load(b) || a.name.localeCompare(b.name))[0];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(epochSeconds: number | undefined, now: Date): string {
	if (epochSeconds === undefined) {
		return "-";
	}
	const at = new Date(epochSeconds * 1000);
	const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	if (at.toDateString() === now.toDateString()) {
		return hm;
	}
	return `${DAYS[at.getDay()]} ${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

function percent(value: number | undefined): string {
	return value === undefined ? "  -" : `${String(Math.round(value * 100)).padStart(3)}%`;
}

/** The usage table `limen accounts` prints under the rotator's report. */
export function formatUsage(rows: readonly Usage[], now: Date = new Date()): string {
	if (rows.length === 0) {
		return "";
	}
	const width = Math.max(...rows.map((row) => row.name.length));
	const lines = rows.map((row) => {
		const name = row.name.padEnd(width);
		const aliasNote = row.aliases.length > 0 ? `  (also ${row.aliases.join(", ")})` : "";
		const alias = row.sameLimitAs ? `${aliasNote}  (same limit as ${row.sameLimitAs})` : aliasNote;
		if (row.error) {
			return `  ${name}  usage unknown (${row.error})${alias}`;
		}
		const flag = row.status === "rejected" ? "  FULL" : "";
		return `  ${name}  5h ${percent(row.fiveHour)} resets ${clock(row.fiveHourReset, now)}   week ${percent(row.sevenDay)} resets ${clock(row.sevenDayReset, now)}${flag}${alias}`;
	});
	return ["usage (one tiny request per account):", ...lines].join("\n");
}
