import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../project/inherit.ts";
import { seatDir } from "../project/seat.ts";

const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;

/**
 * Starts the stack-doctor script when the seat has opted in (`~/.limen/stack-doctor.on`).
 * A missing marker, or a missing script, does nothing. The spawn is detached and never throws.
 */
export function triggerStackDoctor(jobId: string): void {
	try {
		if (!existsSync(join(seatDir(), "stack-doctor.on"))) {
			return;
		}
		const script = join(packageRoot(), "docs/seat/stack-doctor.sh");
		if (!existsSync(script)) {
			return;
		}
		const reason = JOB.test(jobId) ? `job ${jobId} failed` : "job failed";
		const child = spawn(script, ["--reason", reason], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// The job result is already recorded. A trigger must not change it.
	}
}
