// S18 · usage per seat account is read from response headers, and a host job bills the account it was told to.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatUsage, leastLoaded, probeUsage, readSeatUsage, type Usage } from "../src/runtime/account-usage.ts";
import { listSeatAccounts, resolveNamedAccount } from "../src/runtime/claude-account.ts";
import { chooseHostAccount, recordedAccount } from "../src/runtime/host-account.ts";

const previous = process.env.LIMEN_CLAUDE_ACCOUNTS;
after(() => {
	if (previous === undefined) {
		delete process.env.LIMEN_CLAUDE_ACCOUNTS;
	} else {
		process.env.LIMEN_CLAUDE_ACCOUNTS = previous;
	}
});

const tok = (n: string) => `sk-ant-oat01-${n.padEnd(24, "x")}`;

async function seat(tokens: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "limen-accounts-"));
	for (const [name, token] of Object.entries(tokens)) {
		await writeFile(join(root, `${name}.token`), `${token}\n`);
	}
	process.env.LIMEN_CLAUDE_ACCOUNTS = root;
	return root;
}

function answer(status: number, fiveHour?: number, sevenDay?: number, state = "allowed"): Response {
	const headers = new Headers();
	if (fiveHour !== undefined) {
		headers.set("anthropic-ratelimit-unified-5h-utilization", String(fiveHour));
		headers.set("anthropic-ratelimit-unified-5h-reset", "1794491400");
	}
	if (sevenDay !== undefined) {
		headers.set("anthropic-ratelimit-unified-7d-utilization", String(sevenDay));
	}
	headers.set("anthropic-ratelimit-unified-status", state);
	return new Response("{}", { status, headers });
}

test("two files with one token are one account, and an alias resolves to it", async () => {
	const root = await seat({ a: tok("one"), b: tok("two"), c: tok("one") });
	assert.deepEqual(
		listSeatAccounts(root).map((x) => [x.name, x.aliases]),
		[
			["a", ["c"]],
			["b", []],
		],
	);
	assert.equal(resolveNamedAccount("c", root)?.name, "a");
	assert.equal(resolveNamedAccount("nope", root), undefined);
});

test("usage comes from the headers, a refusal included, and the token never leaves the request", async () => {
	let sent: RequestInit | undefined;
	const ok = await probeUsage(tok("one"), {}, async (_url, init) => {
		sent = init;
		return answer(200, 0.38, 0.3);
	});
	assert.deepEqual([ok.fiveHour, ok.sevenDay, ok.status, ok.error], [0.38, 0.3, "allowed", undefined]);
	assert.equal(JSON.stringify(ok).includes("sk-ant"), false);
	assert.ok(sent);
	assert.equal((sent.headers as Record<string, string>).authorization, `Bearer ${tok("one")}`);
	const full = await probeUsage(tok("one"), {}, async () => answer(429, 1, 0.68, "rejected"));
	assert.deepEqual([full.fiveHour, full.status], [1, "rejected"]);
	const bare = await probeUsage(tok("one"), {}, async () => answer(429));
	assert.equal(bare.error, "http 429");
	const down = await probeUsage(tok("one"), {}, async () => {
		throw new Error("offline");
	});
	assert.equal(down.error, "Error");
});

test("the least loaded account is the one whose fuller window is emptiest, and spent ones are skipped", () => {
	const rows: Usage[] = [
		{ name: "a", aliases: [], fiveHour: 0.38, sevenDay: 0.3, status: "allowed" },
		{ name: "b", aliases: [], fiveHour: 1, sevenDay: 0.1, status: "rejected" },
		{ name: "c", aliases: [], fiveHour: 0.04, sevenDay: 0.34, status: "allowed" },
		{ name: "d", aliases: [], fiveHour: 0.04, sevenDay: 0.26, status: "allowed" },
		{ name: "e", aliases: [], error: "http 500" },
	];
	assert.equal(leastLoaded(rows)?.name, "d");
	assert.equal(leastLoaded(rows.slice(1, 2)), undefined);
	const table = formatUsage(rows, new Date(1794490000_000));
	assert.match(table, /b {2}5h 100% .*FULL/);
	assert.match(table, /e {2}usage unknown \(http 500\)/);
});

test("--account needs a host, refuses unknown and spent accounts, and auto picks the freest", async () => {
	await seat({ a: tok("one"), b: tok("two") });
	const rows: Usage[] = [
		{ name: "a", aliases: [], fiveHour: 1, sevenDay: 0.5, status: "rejected" },
		{ name: "b", aliases: [], fiveHour: 0.1, sevenDay: 0.2, status: "allowed" },
	];
	const probe = async () => rows;
	assert.equal(await chooseHostAccount(undefined, undefined, probe), undefined);
	await assert.rejects(chooseHostAccount("b", undefined, probe), /needs --host/);
	await assert.rejects(chooseHostAccount("zzz", "win", probe), /no such seat account \(have: a, b\)/);
	await assert.rejects(chooseHostAccount("a", "win", probe), /no quota left/);
	assert.equal(await chooseHostAccount("b", "win", probe), "b");
	assert.equal(await chooseHostAccount("auto", "win", probe), "b");
	await assert.rejects(
		chooseHostAccount("auto", "win", async () => rows.slice(0, 1)),
		/no seat account has quota left/,
	);
	// A probe that cannot reach the API does not block a named account; it only cannot vouch for it.
	assert.equal(await chooseHostAccount("a", "win", async () => [{ name: "a", aliases: [], error: "Error" }]), "a");
});

test("the recorded account is read back from the job folder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "limen-job-"));
	assert.equal(recordedAccount(dir), undefined);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "account"), "b\n");
	assert.equal(recordedAccount(dir), "b");
});

test("readSeatUsage probes every distinct account once", async () => {
	const root = await seat({ a: tok("one"), b: tok("two"), c: tok("one") });
	let calls = 0;
	const rows = await readSeatUsage(root, {}, async () => {
		calls += 1;
		return answer(200, 0.1, 0.2);
	});
	assert.equal(calls, 2);
	assert.deepEqual(
		rows.map((r) => r.name),
		["a", "b"],
	);
});
