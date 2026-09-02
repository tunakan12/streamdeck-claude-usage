/** 残り秒数を "4h07m" / "5d14h" / "42m" のような短い文字列にする */
export function formatRemaining(seconds) {
	if (seconds == null || !Number.isFinite(seconds)) return "--";
	const s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;

	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;

	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;

	const d = Math.floor(h / 24);
	return `${d}d${String(h % 24).padStart(2, "0")}h`;
}

/** ISO 文字列 / UNIX 秒 のどちらでも受けて、いまからの残り秒数にする */
export function remainingSeconds(resetAt) {
	if (resetAt == null) return null;

	let ms;
	if (typeof resetAt === "number") {
		// 10 桁なら秒、13 桁ならミリ秒
		ms = resetAt > 1e11 ? resetAt : resetAt * 1000;
	} else {
		ms = Date.parse(resetAt);
	}

	if (!Number.isFinite(ms)) return null;
	return Math.max(0, Math.round((ms - Date.now()) / 1000));
}
