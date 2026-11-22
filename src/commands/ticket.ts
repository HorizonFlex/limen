import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPicture } from "../picture/picture-build.ts";
import { ID_PATTERN } from "../picture/picture-model.ts";
import { currentBranch, limenRoot, repoRoot } from "../project/git.ts";
import { closeTickets } from "../project/lanes.ts";
import { parseFlags } from "./flags.ts";
import { landTicketCheck } from "./land.ts";

const HELP = [
	'limen ticket new "what becomes true" [--lane planned|active] [--touches id,id]',
	"limen ticket check [BRANCH]  # the land gate for tickets BRANCH adds or changes against the plant branch; default: this checkout's branch",
	"limen ticket done FNNN [FNNN ...] [--on YYYY-MM-DD]  # landed without limen land: move the active ticket to done/ with its landed date (default today); NOW and PROVEN follow",
].join("\n");
const PLACE_ID = ID_PATTERN;

async function directories(path: string): Promise<string[]> {
	const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return [];
		}
		throw error;
	});
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** The folder slug: the title's slug cut at the last `-` that keeps it at most `max` characters; a longer first word is cut at `max`. */
function folderSlug(title: string, max = 60): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	if (slug.length <= max) {
		return slug;
	}
	const cut = slug.slice(0, max + 1).lastIndexOf("-");
	return cut > 0 ? slug.slice(0, cut) : slug.slice(0, max);
}

const FOLDER_NUMBER = /^F(\d+)-/;

/** The highest ticket number in the folders of spec/features on every local branch and every remote's ref. */
function highestOnRefs(root: string): { highest: number; branches: string } {
	const listed =
		spawnSync("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"], {
			cwd: root,
			encoding: "utf8",
		}).stdout ?? "";
	const refs = listed
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ commit: line.slice(0, line.indexOf(" ")), name: line.slice(line.indexOf(" ") + 1) }));
	let highest = 0;
	for (const commit of new Set(refs.map((ref) => ref.commit))) {
		const tree =
			spawnSync("git", ["ls-tree", "-r", "-d", "--name-only", commit, "--", "spec/features"], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			}).stdout ?? "";
		for (const path of tree.split("\n")) {
			const match = FOLDER_NUMBER.exec(path.slice(path.lastIndexOf("/") + 1));
			if (match) {
				highest = Math.max(highest, Number(match[1]));
			}
		}
	}
	// Local and remote `limen/*` branch names, for a number that has a branch before it has a folder.
	const branches = refs
		.map((ref) => ref.name)
		.filter((name) => /^refs\/(heads|remotes\/[^/]+)\/limen\//.test(name))
		.join("\n");
	return { highest, branches };
}

/** One above the highest ticket number in this checkout, on every branch and remote ref, and in every job label. */
async function nextFeatureNumber(root: string, plant: string): Promise<number> {
	const refs = highestOnRefs(root);
	let highest = refs.highest;
	const base = join(root, "spec", "features");
	for (const lane of ["planned", "active", "done", "dropped"]) {
		const lanePath = join(base, lane);
		const parents =
			lane === "done" || lane === "dropped"
				? (await directories(lanePath)).map((month) => join(lanePath, month))
				: [lanePath];
		for (const parent of parents) {
			for (const name of await directories(parent)) {
				const match = FOLDER_NUMBER.exec(name);
				if (match) {
					highest = Math.max(highest, Number(match[1]));
				}
			}
		}
	}
	// A number can live only in a branch name or a job before its folder is committed (the two F778 tickets).
	const jobs = join(plant, ".limen", "jobs");
	const labels = await Promise.all(
		(await directories(jobs)).map(
			async (id) => `${id}\n${await readFile(join(jobs, id, "label"), "utf8").catch(() => "")}`,
		),
	);
	for (const match of `${refs.branches}\n${labels.join("\n")}`.matchAll(/\bf(\d{3,4})\b/gi)) {
		highest = Math.max(highest, Number(match[1]));
	}
	return highest + 1;
}

export async function ticketCommand(args: readonly string[], cwd: string): Promise<void> {
	if (args[0] === "check") {
		return ticketCheck(args.slice(1), cwd);
	}
	if (args[0] === "done") {
		return ticketDone(args.slice(1), cwd);
	}
	const [mode, title, ...options] = args;
	if (mode !== "new" || !title || title.startsWith("--") || /[\r\n]/.test(title) || !title.trim()) {
		throw new Error(HELP);
	}
	const help = () => HELP;
	const { values } = parseFlags(options, { lane: { type: "string" }, touches: { type: "string" } } as const, {
		unknown: help,
		missing: help,
		repeated: help,
		positionals: false,
		endOfFlags: false,
	});
	if (values.lane !== undefined && values.lane !== "planned" && values.lane !== "active") {
		throw new Error(HELP);
	}
	const lane = values.lane ?? "planned";
	const touches = values.touches?.split(",") ?? [];
	if (!touches.every((id) => PLACE_ID.test(id)) || new Set(touches).size !== touches.length) {
		throw new Error(HELP);
	}
	const slug = folderSlug(title);
	if (!slug) {
		throw new Error(HELP);
	}
	const root = repoRoot(cwd);
	const plant = process.env.LIMEN_CONTEXT_ROOT ?? root;
	if (touches.length) {
		const local = join(root, ".limen", "picture");
		const dir = existsSync(local) ? local : join(plant, ".limen", "picture");
		const map = await readPicture(dir);
		if (map.diagnostics.some((item) => item.level === "error")) {
			throw new Error(`the map at ${dir} has errors; run limen picture build --dir ${dir} --strict to see them`);
		}
		// The same places the strict check and the land gate accept: modules and the plant.
		const places = new Set(map.nodes.filter((node) => node.kind === "module").map((node) => node.id));
		if (map.project.rootId) {
			places.add(map.project.rootId);
		}
		const unknown = touches.find((id) => !places.has(id));
		if (unknown) {
			throw new Error(`unknown map place id "${unknown}"; choose the id: of a module or plant file in ${dir}/nodes/`);
		}
	}
	const base = join(root, "spec", "features");
	const code = `F${String(await nextFeatureNumber(root, plant)).padStart(3, "0")}`;
	const path = join("spec", "features", lane, `${code}-${slug}`, "ticket.md");
	const now = new Date();
	const opened = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const normalizedTitle = title.trim();
	const outcome = /[.!?]$/.test(normalizedTitle) ? normalizedTitle : `${normalizedTitle}.`;
	const template = await readFile(join(base, "_template", "ticket.md"), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") {
				throw error;
			}
			return readFile(
				fileURLToPath(new URL("../../templates/spec/features/_template/ticket.md", import.meta.url)),
				"utf8",
			);
		},
	);
	const start = template.indexOf("## Outcome\n");
	if (start < 0) {
		throw new Error("ticket template needs an ## Outcome section");
	}
	const text = `---\n${touches.length ? `touches:\n${touches.map((id) => `  - ${id}\n`).join("")}` : ""}opened: ${opened}\n---\n\n# ${code} · ${normalizedTitle}\n\n${template.slice(start).replace("## Outcome\n", `## Outcome\n\n${outcome}\n`)}`;
	await mkdir(join(root, "spec", "features", lane), { recursive: true });
	await mkdir(join(root, "spec", "features", lane, `${code}-${slug}`));
	await writeFile(join(root, path), text, { flag: "wx" });
	console.log(path);
}

/** The close `limen land` makes, for work that landed by a hand merge or needed no code. */
async function ticketDone(args: readonly string[], cwd: string): Promise<void> {
	const help = () => HELP;
	const { values, positionals: codes } = parseFlags(args, { on: { type: "string" } } as const, {
		unknown: help,
		missing: help,
		repeated: help,
		endOfFlags: false,
	});
	const on = values.on;
	if (codes.length === 0 || !codes.every((code) => /^F\d+$/i.test(code)) || (on && !/^\d{4}-\d\d-\d\d$/.test(on))) {
		throw new Error(HELP);
	}
	const root = limenRoot(cwd);
	const closed = await (on ? closeTickets(root, codes, `landed ${on}`, on) : closeTickets(root, codes, "landed"));
	const missing = codes.filter((code) => !closed.moved.some((path) => path.includes(`/${code.toUpperCase()}-`)));
	for (const path of closed.moved) {
		console.log(`closed ${path}${closed.commit ? ` in ${closed.commit}` : ""}`);
	}
	if (missing.length) {
		throw new Error(`no active ticket for ${missing.join(", ")} in ${root}/spec/features/active/`);
	}
}

/** The land gate on demand, so a hand merge or a keeper can check a branch before it reaches the plant branch. */
async function ticketCheck(args: readonly string[], cwd: string): Promise<void> {
	if (args.length > 1 || args[0]?.startsWith("-")) {
		throw new Error(HELP);
	}
	const repository = repoRoot(cwd);
	const plant = process.env.LIMEN_CONTEXT_ROOT ?? limenRoot(cwd);
	const target = currentBranch(plant);
	const branch = args[0] ?? currentBranch(repository);
	if (branch === target) {
		throw new Error(
			`ticket check compares a branch with ${target}; name the branch to check: limen ticket check BRANCH`,
		);
	}
	const job =
		branch.startsWith("limen/") && existsSync(join(plant, ".limen", "jobs", branch.slice("limen/".length)))
			? branch.slice("limen/".length)
			: "<id>";
	const gate = await landTicketCheck(repository, plant, branch, target, job);
	for (const line of gate.lines) {
		(gate.ok ? console.log : console.error)(line);
	}
	if (!gate.ok) {
		process.exitCode = 1;
	} else {
		console.log(
			`ticket check: ${gate.tickets.length} changed ticket${gate.tickets.length === 1 ? "" : "s"} on ${branch} pass against ${target}`,
		);
	}
}
