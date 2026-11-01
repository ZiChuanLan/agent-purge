// 配置值与执行许可分开：暂停不擦掉选择，环境变量本身不授予许可。
export function resolveConfigured(state, id) {
	const modes = ["strict", "replace", "append", "off"];
	const override = state?.overrides?.[id] ?? {};
	const hasPersona = typeof override.persona === "string" && override.persona !== "";
	const hasMode = modes.includes(override.mode);
	return {
		persona: hasPersona ? override.persona : state?.persona ?? null,
		mode: hasMode ? override.mode : state?.default?.mode ?? "replace",
		personaFrom: hasPersona ? "override" : "global", modeFrom: hasMode ? "override" : "global",
	};
}

/** launch 只能由通过进程归属核验的调用方传入 true，绝不直接来自 FORCE/token。 */
export function resolveActivation(state, id, context = {}) {
	const configured = resolveConfigured(state, id);
	const mode = context.mode ?? configured.mode;
	const result = { ...configured, persona: context.persona ?? configured.persona, configuredMode: configured.mode, mode, on: false, source: null, blockedBy: null };
	const stop = reason => ({ ...result, mode: "off", blockedBy: reason });
	if (!state || typeof state !== "object" || Array.isArray(state)) return stop("missing-state");
	if (state.default?.mode === "off") return stop("global-pause");
	if (state.overrides?.[id]?.mode === "off") return stop("harness-off");
	if (Array.isArray(state.disabledHarnesses) && state.disabledHarnesses.includes(id)) return stop("harness-disabled");
	if (context.session === false || context.enabled === false) return stop("session-off");
	if (context.profile && Array.isArray(state.dshProfiles) && !state.dshProfiles.includes(context.profile)) return stop("profile-off");
	if (!["strict", "replace", "append"].includes(mode)) return stop(mode === "off" ? "mode-off" : "invalid-mode");
	const channels = Array.isArray(state.armed?.[id]) ? state.armed[id] : [];
	let source = null;
	if (context.launch === true) source = "explicit-launch";
	else if (context.channel === "install" && channels.includes("install")) source = "resident";
	else if (context.channel === "slash" && channels.includes("slash")) {
		if (context.session === true) source = "session-command";
		else if (state[id + "Auto"] === true) source = "auto";
	}
	return source ? { ...result, on: true, source } : stop("not-enabled");
}

export const activationRuntime = [resolveConfigured, resolveActivation].map(fn => fn.toString()).join("\n") + "\nconst resolveCfg = resolveConfigured;\n";
