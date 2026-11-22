import { ENGINES, engineRoute } from "./engine.ts";

// Pi sends a `sk-ant-oat` token to the anthropic provider as `Authorization: Bearer`. Anthropic rejects that
// (`OAuth authentication is currently not supported`). pi-claude-bridge sends the same token as `x-api-key` via
// `CLAUDE_CODE_OAUTH_TOKEN`, which is the call that works. A normal API key (`sk-ant-api…`) can travel as `ANTHROPIC_API_KEY`.
const OAT = /^sk-ant-oat/;

export type HostRoute = {
	readonly ok: true;
	readonly provider: string | undefined;
	readonly model: string | undefined;
	readonly bridged: boolean;
	/** Set when a non-OAuth token should be exported as Pi's anthropic API key. */
	readonly apiKey: boolean;
	/** Set when an anthropic model was rewritten to the bridge. The log line, with no token. */
	readonly mapped?: string;
};

export type HostRouteRefusal = { readonly ok: false; readonly reason: string };

/** How this provider and model can run on a host with the seat account token, if there is one. */
export function hostClaudeRoute(input: {
	readonly provider?: string | undefined;
	readonly model?: string | undefined;
	readonly token?: string | undefined;
}): HostRoute | HostRouteRefusal {
	const provider = input.provider?.trim() || undefined;
	const model = input.model?.trim() || undefined;
	const route = engineRoute(ENGINES.pi, provider, model);
	if (route.bridged) {
		return { ok: true, provider: route.provider, model: route.model, bridged: true, apiKey: false };
	}
	if (!isAnthropic(provider, model)) {
		return { ok: true, provider, model, bridged: false, apiKey: false };
	}
	const name = anthropicModel(provider, model);
	if (!name) {
		return { ok: false, reason: "anthropic model name is missing" };
	}
	if (!input.token) {
		return {
			ok: false,
			reason: `anthropic/${name} needs the seat Claude account; the host has no Pi anthropic login from the seat`,
		};
	}
	if (!OAT.test(input.token)) {
		return { ok: true, provider, model, bridged: false, apiKey: true };
	}
	const mapped = `claude-bridge/${name}`;
	return {
		ok: true,
		provider: undefined,
		model: mapped,
		bridged: true,
		apiKey: false,
		mapped: `anthropic/${name} -> ${mapped}`,
	};
}

/** Lines for `limen hosts check`. Names the account. Never includes the token. */
export function seatProviderReport(
	alias: string,
	accountName: string | undefined,
	token: string | undefined,
	bridge: boolean,
): readonly string[] {
	if (!accountName || !token) {
		return [`${alias}: claude-bridge: no seat account`, `${alias}: anthropic: no seat account`];
	}
	const bridgeLine = bridge
		? `${alias}: claude-bridge seat account ${accountName}: ok`
		: `${alias}: claude-bridge seat account ${accountName}: no pi-claude-bridge on this host`;
	const plan = hostClaudeRoute({ provider: "anthropic", model: "claude-opus-5-5", token });
	const anthropicLine = !plan.ok
		? `${alias}: anthropic seat account ${accountName}: ${plan.reason}`
		: plan.mapped
			? bridge
				? `${alias}: anthropic seat account ${accountName}: runs as claude-bridge (bridge ok)`
				: `${alias}: anthropic seat account ${accountName}: unavailable, no pi-claude-bridge`
			: `${alias}: anthropic seat account ${accountName}: ok (ANTHROPIC_API_KEY)`;
	return [bridgeLine, anthropicLine];
}

function isAnthropic(provider: string | undefined, model: string | undefined): boolean {
	return provider === "anthropic" || !!model?.startsWith("anthropic/");
}

function anthropicModel(provider: string | undefined, model: string | undefined): string {
	if (model?.startsWith("anthropic/")) {
		return model.slice("anthropic/".length);
	}
	if (provider === "anthropic") {
		return model ?? "";
	}
	return "";
}
