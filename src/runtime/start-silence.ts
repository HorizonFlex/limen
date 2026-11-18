// An engine that never prints a byte after it starts holds a job for the whole job timeout. This watchdog ends that
// early. Any output on stdout or stderr counts as life; only total silence from the first moment trips it.
export const DEFAULT_START_SILENCE_MS = 10 * 60_000;

/** Milliseconds of total silence allowed after the engine starts; 0 turns the watchdog off. */
export function startSilenceMs(value: string | undefined): number {
	const raw = value?.trim();
	if (!raw) {
		return DEFAULT_START_SILENCE_MS;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_START_SILENCE_MS;
}

export type StartSilenceWatch = {
	/** Call on every chunk the engine writes; the first call disarms the watchdog. */
	readonly heard: () => void;
	/** Call when the engine exits or the job is ending. */
	readonly stop: () => void;
};

export function watchStartSilence(ms: number, onSilent: (ms: number) => void): StartSilenceWatch {
	if (ms <= 0) {
		return { heard() {}, stop() {} };
	}
	const timer = setTimeout(() => onSilent(ms), ms);
	timer.unref();
	return {
		heard: () => clearTimeout(timer),
		stop: () => clearTimeout(timer),
	};
}
