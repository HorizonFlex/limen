import assert from "node:assert/strict";
import test from "node:test";
import { sessionWarnBytes, sessionWeightWarning } from "../src/job/session-weight.ts";
import { DEFAULT_START_SILENCE_MS, startSilenceMs, watchStartSilence } from "../src/runtime/start-silence.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("silence limit reads one number, 0 turns it off, anything else is the default", () => {
	assert.equal(startSilenceMs(undefined), DEFAULT_START_SILENCE_MS);
	assert.equal(startSilenceMs(" "), DEFAULT_START_SILENCE_MS);
	assert.equal(startSilenceMs("2500"), 2500);
	assert.equal(startSilenceMs("0"), 0);
	assert.equal(startSilenceMs("-5"), DEFAULT_START_SILENCE_MS);
	assert.equal(startSilenceMs("soon"), DEFAULT_START_SILENCE_MS);
});

test("a silent start trips the watchdog once", async () => {
	let tripped = 0;
	const watch = watchStartSilence(20, () => {
		tripped += 1;
	});
	await pause(80);
	watch.stop();
	assert.equal(tripped, 1);
});

test("the first output disarms the watchdog", async () => {
	let tripped = 0;
	const watch = watchStartSilence(30, () => {
		tripped += 1;
	});
	watch.heard();
	await pause(90);
	watch.stop();
	assert.equal(tripped, 0);
});

test("a stopped watchdog and a disabled one never trip", async () => {
	let tripped = 0;
	watchStartSilence(20, () => {
		tripped += 1;
	}).stop();
	watchStartSilence(0, () => {
		tripped += 1;
	});
	await pause(80);
	assert.equal(tripped, 0);
});

test("a heavy session gets one warning line and a light one none", () => {
	const limit = sessionWarnBytes(undefined);
	assert.equal(sessionWeightWarning(limit, limit), "");
	assert.match(sessionWeightWarning(limit + 1, limit), /^warning: the saved session is \d+\.\d MB;/);
	assert.equal(sessionWeightWarning(10 * limit, 0), "", "0 turns the warning off");
	assert.equal(sessionWarnBytes("1024"), 1024);
	assert.equal(sessionWarnBytes("lots"), limit);
});
