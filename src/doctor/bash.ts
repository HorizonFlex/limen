import { type ChildProcess, spawn } from "node:child_process";
import type { ShellText } from "../runtime/host-shell.ts";

/** Runs a bash script with the script on stdin, so its text is not the process command line. */
export function runBash(script: string, timeoutMs: number): Promise<ShellText> {
	const { promise, resolve } = Promise.withResolvers<ShellText>();
	let child: ChildProcess;
	try {
		child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
		return promise;
	}
	finishBash(child, script, timeoutMs, resolve);
	return promise;
}

function finishBash(child: ChildProcess, script: string, timeoutMs: number, resolve: (value: ShellText) => void): void {
	let stdout = "";
	let stderr = "";
	let settled = false;
	const finish = (code: number | null) => {
		if (settled) {
			return;
		}
		settled = true;
		resolve({ code, stdout, stderr });
	};
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(null);
	}, timeoutMs);
	timer.unref?.();
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.once("error", (error) => {
		stderr += error.message;
		clearTimeout(timer);
		finish(null);
	});
	child.once("close", (code) => {
		clearTimeout(timer);
		finish(code);
	});
	child.stdin?.end(script);
}
