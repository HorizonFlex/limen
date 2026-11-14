import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { showSeatNotification } from "../integrations/herdr.ts";
import { seatDir } from "../project/seat.ts";
import { redact } from "./parse.ts";

const DEFAULT_HOURS = 24;

export type NotifyMark = { readonly fingerprint: string; readonly at: number };
export type NotifyBook = Readonly<Record<string, NotifyMark>>;

export type FindingMark = { readonly host: string; readonly id: string; readonly summary: string };

/** Hours before the same notice may be sent again. `LIMEN_DOCTOR_RENOTIFY_HOURS`, default 24. */
export function renotifyMs(env: NodeJS.ProcessEnv = process.env): number {
	const hours = Number(env.LIMEN_DOCTOR_RENOTIFY_HOURS);
	const chosen = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS;
	return chosen * 60 * 60 * 1000;
}

export function findingFingerprint(findings: readonly FindingMark[]): string {
	const lines = findings.map((finding) => `${finding.host}\t${finding.id}\t${finding.summary}`).sort();
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function notifyFingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Send when this slot has not been sent, the text changed, or the last send is older than the window.
 * An unchanged set inside the window stays quiet.
 */
export function claimNotify(
	book: NotifyBook,
	slot: string,
	fingerprint: string,
	now: number,
	windowMs: number,
): { readonly send: boolean; readonly book: NotifyBook } {
	const previous = book[slot];
	if (previous && previous.fingerprint === fingerprint && now - previous.at < windowMs) {
		return { send: false, book };
	}
	return { send: true, book: { ...book, [slot]: { fingerprint, at: now } } };
}

export function noticeKey(slot: string, message: string, findings: readonly FindingMark[] = []): string {
	return notifyFingerprint(`${slot}\n${message}\n${findingFingerprint(findings)}`);
}

function bookPath(): string {
	return join(seatDir(), "stack-doctor", "notify.json");
}

export function readNotifyBook(path = bookPath()): NotifyBook {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const book: Record<string, NotifyMark> = {};
		for (const [slot, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				continue;
			}
			const mark = value as { fingerprint?: unknown; at?: unknown };
			if (typeof mark.fingerprint === "string" && typeof mark.at === "number") {
				book[slot] = { fingerprint: mark.fingerprint, at: mark.at };
			}
		}
		return book;
	} catch {
		return {};
	}
}

export function writeNotifyBook(book: NotifyBook, path = bookPath()): void {
	writeFileSync(path, `${JSON.stringify(book)}\n`, { mode: 0o600 });
}

export function findingsInReport(text: string): FindingMark[] {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || !("findings" in parsed) || !Array.isArray(parsed.findings)) {
			return [];
		}
		const marks: FindingMark[] = [];
		for (const row of parsed.findings) {
			if (!row || typeof row !== "object") {
				continue;
			}
			const finding = row as { host?: unknown; id?: unknown; summary?: unknown };
			if (typeof finding.id === "string" && typeof finding.summary === "string") {
				marks.push({
					host: typeof finding.host === "string" ? finding.host : "",
					id: finding.id,
					summary: finding.summary,
				});
			}
		}
		return marks;
	} catch {
		return [];
	}
}

/** Moshi and the seat notification, once per distinct text until the renotify window passes. */
export async function deliverNotice(
	slot: string,
	message: string,
	findings: readonly FindingMark[] = [],
): Promise<boolean> {
	const fingerprint = noticeKey(slot, message, findings);
	const decision = claimNotify(readNotifyBook(), slot, fingerprint, Date.now(), renotifyMs());
	if (!decision.send) {
		return false;
	}
	await mkdir(join(seatDir(), "stack-doctor"), { recursive: true });
	writeNotifyBook(decision.book);
	const note = redact(message).slice(0, 240);
	spawnSync("moshi-hook", ["notify", "--title", "Limen stack doctor", "--source", "stack-doctor", note], {
		timeout: 8_000,
	});
	await showSeatNotification("Limen stack doctor", note);
	return true;
}
