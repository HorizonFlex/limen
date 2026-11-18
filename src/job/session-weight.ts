// A continue replays the whole saved session into a new engine process, with no prompt-cache hit on the first turn.
// A very large transcript makes that start slow and spends a lot of the account's usage window.
export const DEFAULT_SESSION_WARN_BYTES = 8 * 1024 * 1024;

/** Bytes above which a continue warns; 0 turns the warning off. */
export function sessionWarnBytes(value: string | undefined): number {
	const raw = value?.trim();
	if (!raw) {
		return DEFAULT_SESSION_WARN_BYTES;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_SESSION_WARN_BYTES;
}

/** One warning line for a heavy session, or an empty string when the session is small enough. */
export function sessionWeightWarning(bytes: number, limit: number): string {
	if (limit <= 0 || bytes <= limit) {
		return "";
	}
	const megabytes = (bytes / (1024 * 1024)).toFixed(1);
	return `warning: the saved session is ${megabytes} MB; a continue replays all of it and starts slowly with no cache hit. Prefer a new job on the same branch when the follow-up does not need that history.`;
}
