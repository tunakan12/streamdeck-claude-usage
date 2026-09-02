/**
 * 144x144 のキー画像を SVG で描く。
 * 上段 = 5時間ウィンドウ、下段 = 週ウィンドウ。
 * それぞれ「残り%」（または使用率）と、リセットまでの残り時間を出す。
 */

const CANVAS = 144;

const COL = {
	bg: "#0E0F11",
	track: "#2C2C2E",
	label: "#C7C7CC",
	sub: "#8E8E93",
	head: "#9A9AA0",
	dim: "#5A5A5F",
};

/** 残り% に応じた色（多いほど緑、少ないほど赤） */
export function remainingColor(remaining) {
	if (remaining == null) return COL.dim;
	if (remaining <= 10) return "#FF3B30";
	if (remaining <= 25) return "#FF9F0A";
	if (remaining <= 50) return "#FFD60A";
	return "#34C759";
}

function esc(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function text(content, { x, y, size, weight = 400, fill, anchor = "start", spacing = 0 }) {
	return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}"${spacing ? ` letter-spacing="${spacing}"` : ""}>${esc(content)}</text>`;
}

function bar(y, ratio, color) {
	const x = 8;
	const w = CANVAS - 16;
	const h = 8;
	const filled = Math.max(0, Math.min(1, ratio ?? 0)) * w;

	const track = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${COL.track}"/>`;
	if (filled <= 0.5) return track;

	return `${track}<rect x="${x}" y="${y}" width="${filled.toFixed(2)}" height="${h}" rx="${h / 2}" fill="${color}"/>`;
}

/**
 * 1 ブロック（ラベル・残り時間・パーセント・バー）を描く。
 * @param {object} o
 * @param {number} o.top       ブロックの上端 y
 * @param {string} o.label     "5H" / "7D"
 * @param {number|null} o.remaining 残り%（0-100）
 * @param {string} o.resetText "4h07m"
 * @param {boolean} o.showUsed 使用率表示にするか
 */
function block({ top, label, remaining, resetText, showUsed }) {
	const color = remainingColor(remaining);
	const value = remaining == null ? null : showUsed ? 100 - remaining : remaining;
	const valueText = value == null ? "--" : `${Math.round(value)}%`;

	// ラベルが長いほど小さく。数字と重ならないよう、数字の側も一段落とす。
	const labelSize = label.length > 6 ? 12 : label.length > 4 ? 14 : 18;
	const valueSize = label.length > 4 && valueText.length > 3 ? 23 : label.length > 4 ? 26 : 29;

	return [
		text(label, { x: 8, y: top + 20, size: labelSize, weight: 700, fill: COL.label }),
		text(valueText, { x: CANVAS - 8, y: top + 22, size: valueSize, weight: 700, fill: color, anchor: "end" }),
		bar(top + 29, remaining == null ? 0 : remaining / 100, color),
		text(resetText, { x: CANVAS - 8, y: top + 53, size: 15, fill: COL.sub, anchor: "end" }),
	].join("");
}

function wrap(body) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}"><rect width="${CANVAS}" height="${CANVAS}" rx="18" fill="${COL.bg}"/>${body}</svg>`;
}

function toDataUri(svg) {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * 通常表示。
 * @param {object} o
 * @param {string} o.title      ヘッダー文字（CLAUDE / CODEX）
 * @param {string} o.accent     ヘッダーの色
 * @param {{remaining:number|null, resetText:string}} o.session 5時間ウィンドウ
 * @param {{remaining:number|null, resetText:string}} o.weekly  週ウィンドウ
 * @param {boolean} [o.showUsed]
 * @param {boolean} [o.stale]   取得が古い（キャッシュ表示）
 */
export function usageDataUri({ title, accent, session, weekly, showUsed = false, stale = false, weeklyLabel = "7D" }) {
	const body = [
		text(title, { x: CANVAS / 2, y: 20, size: 16, weight: 700, fill: stale ? COL.dim : accent, anchor: "middle", spacing: 1.4 }),
		stale ? text("*", { x: CANVAS - 8, y: 20, size: 16, weight: 700, fill: COL.dim, anchor: "end" }) : "",
		block({ top: 26, label: "5H", remaining: session.remaining, resetText: session.resetText, showUsed }),
		block({ top: 86, label: weeklyLabel, remaining: weekly.remaining, resetText: weekly.resetText, showUsed }),
	].join("");

	return toDataUri(wrap(body));
}

/** エラー・未設定などのメッセージ表示 */
export function messageDataUri({ title, accent, lines }) {
	const rows = lines.slice(0, 3).map((line, i) =>
		text(line, { x: CANVAS / 2, y: 62 + i * 26, size: line.length > 12 ? 15 : 18, weight: 600, fill: i === 0 ? "#FF9F0A" : COL.sub, anchor: "middle" }),
	);

	const body = [
		text(title, { x: CANVAS / 2, y: 24, size: 16, weight: 700, fill: accent, anchor: "middle", spacing: 1.4 }),
		...rows,
	].join("");

	return toDataUri(wrap(body));
}
