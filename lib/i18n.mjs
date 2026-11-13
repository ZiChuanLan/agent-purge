// Locale detection and lightweight bilingual helper.
// Follows LC_ALL -> LC_MESSAGES -> LANG -> (Windows Intl fallback) -> "en".
// Any non-Chinese environment falls back to English.

export const SUPPORTED_LOCALES = ["en", "zh-CN"];
export const DEFAULT_LOCALE = "en";

export function normalizeLocale(value) {
	if (typeof value !== "string") return null;
	const raw = value.trim().toLowerCase();
	if (!raw || raw === "auto") return null;
	if (raw === "c" || raw === "posix" || raw.startsWith("c.")) return "en";
	const base = raw.split(".")[0].split("@")[0].replace(/_/g, "-");
	if (base === "zh" || base.startsWith("zh-")) return "zh-CN";
	return "en";
}

export function normalizeLanguageSetting(value) {
	if (typeof value !== "string") return "auto";
	const raw = value.trim().toLowerCase();
	if (!raw || raw === "auto") return "auto";
	return normalizeLocale(raw) ?? "auto";
}

export function detectSystemLocale(env = process.env, platform = process.platform) {
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env?.[key];
		if (typeof value === "string" && value.trim() !== "") {
			return normalizeLocale(value) ?? DEFAULT_LOCALE;
		}
	}
	if (platform === "win32") {
		try {
			const sys = Intl.DateTimeFormat().resolvedOptions().locale;
			if (sys && sys.toLowerCase().startsWith("zh")) return "zh-CN";
		} catch {}
	}
	return DEFAULT_LOCALE;
}

export function resolveLocale({ setting, env = process.env, platform = process.platform } = {}) {
	const explicit = normalizeLocale(setting);
	if (explicit) return explicit;
	return detectSystemLocale(env, platform);
}

export function isZh(locale) {
	return normalizeLocale(locale) === "zh-CN";
}

export function pickText(locale, zh, en) {
	return isZh(locale) ? zh : en;
}
