import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const UA = "claude-code/2.1.241";

export function claudeHome() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function credentialsPath() {
	return path.join(claudeHome(), ".credentials.json");
}

function readCredentials() {
	const file = credentialsPath();
	if (!existsSync(file)) return null;

	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw?.claudeAiOauth?.accessToken ? { file, raw } : null;
	} catch {
		return null;
	}
}

/**
 * 期限切れのときだけリフレッシュし、結果を同じファイルに書き戻す。
 * 書き戻さないと Claude Code 側のリフレッシュトークンが無効になるため、ここは必須。
 */
async function refreshCredentials(entry) {
	const oauth = entry.raw.claudeAiOauth;
	if (!oauth?.refreshToken) return null;

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": UA },
		body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLIENT_ID }),
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) return null;

	const json = await res.json();
	if (!json?.access_token) return null;

	entry.raw.claudeAiOauth = {
		...oauth,
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? oauth.refreshToken,
		expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
		scopes: json.scope ? json.scope.split(" ") : oauth.scopes,
	};

	// 書き込み途中で壊さないよう、一時ファイル経由で置き換える
	const tmp = `${entry.file}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry.raw, null, 2), { mode: 0o600 });
	renameSync(tmp, entry.file);

	return entry.raw.claudeAiOauth.accessToken;
}

/** Claude Code のログイン情報からアクセストークンを取る（必要ならリフレッシュ） */
async function tokenFromCredentials() {
	const entry = readCredentials();
	if (!entry) return null;

	const oauth = entry.raw.claudeAiOauth;
	const alive = !Number.isFinite(oauth.expiresAt) || oauth.expiresAt > Date.now() + 60_000;
	if (alive) return oauth.accessToken;

	try {
		return await refreshCredentials(entry);
	} catch {
		return null;
	}
}

function pct(value) {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.min(100, 100 - n)) : null;
}

function parseReset(iso) {
	const ms = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(ms) ? ms : null;
}

/** 旧形式（five_hour / seven_day）用 */
function windowFrom(win) {
	if (!win) return { remaining: null, resetAt: null };
	return { remaining: pct(win.utilization), resetAt: parseReset(win.resets_at) };
}

/** limits[] の 1 行につけるラベル。モデル別の枠はモデル名を出す。 */
function labelFor(limit) {
	if (limit.kind === "session") return "5H";
	if (limit.kind === "weekly_all") return "7D";

	const name = limit.scope?.model?.display_name ?? limit.scope?.surface?.display_name ?? limit.scope?.surface;
	return name ? String(name).toUpperCase() : "WEEK";
}

/**
 * limits[] を使って「5時間ウィンドウ」と「週ウィンドウの一覧」に整理する。
 * 週は 全体 → モデル別（Fable など）の順で、キー短押しで切り替えられるようにする。
 */
function parse(json) {
	const list = Array.isArray(json.limits) ? json.limits : [];

	const sessionRow = list.find((l) => l.kind === "session");
	const session = sessionRow
		? { remaining: pct(sessionRow.percent), resetAt: parseReset(sessionRow.resets_at) }
		: windowFrom(json.five_hour);

	const windows = list
		.filter((l) => l.group === "weekly")
		.map((l, i) => ({
			key: l.kind === "weekly_all" ? "all" : (labelFor(l).toLowerCase() || `w${i}`),
			label: labelFor(l),
			remaining: pct(l.percent),
			resetAt: parseReset(l.resets_at),
		}));

	if (windows.length === 0) {
		windows.push({ key: "all", label: "7D", ...windowFrom(json.seven_day) });
		if (json.seven_day_opus) windows.push({ key: "opus", label: "OPUS", ...windowFrom(json.seven_day_opus) });
		if (json.seven_day_sonnet) windows.push({ key: "sonnet", label: "SONNET", ...windowFrom(json.seven_day_sonnet) });
	}

	return { session, weekly: windows[0] ?? { remaining: null, resetAt: null }, windows, stale: false };
}

async function requestUsage(token) {
	const res = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
			"User-Agent": UA,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		const err = new Error(res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : `HTTP ${res.status}`);

		// setup-token のトークンは user:profile を持たないので、ここで区別する
		err.scopeProblem = body.includes("oauth_scope_insufficient");
		err.authProblem = res.status === 401 || res.status === 403;
		throw err;
	}

	const json = await res.json();
	if (!json?.five_hour && !json?.seven_day && !json?.limits) throw new Error("BAD_RESPONSE");

	return parse(json);
}

/**
 * 5時間 / 週の利用状況を取得する。
 * 手入力トークン → Claude Code のログイン情報、の順に試す。
 * @param {string|null} manualToken
 */
export async function getClaudeUsage(manualToken) {
	const manual = (manualToken ?? "").trim();
	let firstError = null;

	if (manual) {
		try {
			return await requestUsage(manual);
		} catch (err) {
			if (!err.authProblem) throw err;
			firstError = err;
		}
	}

	const token = await tokenFromCredentials();
	if (token && token !== manual) return await requestUsage(token);

	if (firstError) throw new Error(firstError.scopeProblem ? "SCOPE" : "UNAUTHORIZED");
	throw new Error("NO_TOKEN");
}
