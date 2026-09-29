import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const UA = "claude-code/2.1.241";

/** トークンの残りがこれを切ったら、Claude Code に更新させる */
const REFRESH_AHEAD_MS = 10 * 60_000;
/** Claude Code を裏で起動するのは、最短でもこの間隔をあける */
const HELPER_COOLDOWN_MS = 30 * 60_000;
/** 裏で起動した Claude Code を待つ上限 */
const HELPER_TIMEOUT_MS = 90_000;

export function claudeHome() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function credentialsPath() {
	return path.join(claudeHome(), ".credentials.json");
}

/** Claude Code が保存した認証情報を読む（書き換えはしない） */
function readCredentials() {
	const file = credentialsPath();
	if (!existsSync(file)) return { exists: false, file };

	try {
		const oauth = JSON.parse(readFileSync(file, "utf8"))?.claudeAiOauth;
		return {
			exists: true,
			file,
			accessToken: oauth?.accessToken ?? null,
			expiresAt: Number.isFinite(oauth?.expiresAt) ? oauth.expiresAt : null,
			modifiedAt: statSync(file).mtimeMs,
		};
	} catch {
		return { exists: true, file, accessToken: null, expiresAt: null, modifiedAt: null };
	}
}

function minutesLeft(creds) {
	return creds.expiresAt == null ? null : Math.round((creds.expiresAt - Date.now()) / 60_000);
}

function isFresh(creds) {
	return Boolean(creds.accessToken) && (creds.expiresAt == null || creds.expiresAt - Date.now() > REFRESH_AHEAD_MS);
}

/* ------------------------------------------------------------------ */
/* Claude Code 自身にトークンを更新させる                              */
/* ------------------------------------------------------------------ */

let helperRunning = null;
let helperLastRun = 0;

function claudeExecutable() {
	const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
	return existsSync(native) ? { cmd: native, shell: false } : { cmd: "claude", shell: true };
}

/**
 * `claude -p /usage` を画面に出さずに実行する。
 * /usage は推論を使わない組み込みコマンドで、有効なトークンを必要とするため、
 * Claude Code が自分の正規の手順でトークンを更新し、保存してから終了する。
 * プラグインが認証サーバーへ直接リクエストを送ることはない。
 */
function runClaudeUsage(logger) {
	if (helperRunning) return helperRunning;

	if (Date.now() - helperLastRun < HELPER_COOLDOWN_MS) {
		logger?.info(`refresh via Claude Code: skipped (cooldown, last run ${Math.round((Date.now() - helperLastRun) / 60_000)} min ago)`);
		return Promise.resolve(false);
	}

	helperLastRun = Date.now();
	const { cmd, shell } = claudeExecutable();
	logger?.info(`refresh via Claude Code: running ${shell ? "claude" : cmd} -p /usage`);

	helperRunning = new Promise((resolve) => {
		let stderr = "";
		let settled = false;
		let timer = null;
		const done = (ok, why) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			logger?.info(`refresh via Claude Code: ${ok ? "finished" : "failed"} (${why})`);
			resolve(ok);
		};

		let child;
		try {
			child = spawn(cmd, ["-p", "/usage"], { shell, windowsHide: true, cwd: os.tmpdir(), stdio: ["ignore", "ignore", "pipe"] });
		} catch (err) {
			done(false, err?.message ?? String(err));
			return;
		}

		child.stderr?.on("data", (d) => {
			stderr = (stderr + d.toString()).slice(-400);
		});
		child.on("error", (err) => done(false, err.message));
		child.on("exit", (code) => done(code === 0, `exit ${code}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`));

		timer = setTimeout(() => {
			if (settled) return;
			child.kill();
			done(false, "timeout");
		}, HELPER_TIMEOUT_MS);
	}).finally(() => {
		helperRunning = null;
	});

	return helperRunning;
}

/**
 * 使えるアクセストークンを返す。
 * 期限が近ければ Claude Code に更新させてから読み直す。
 */
async function tokenFromCredentials(logger) {
	let creds = readCredentials();

	if (!creds.exists) {
		logger?.warn(`credentials not found: ${creds.file}`);
		return { token: null, hadCredentials: false };
	}

	if (isFresh(creds)) return { token: creds.accessToken, hadCredentials: true };

	logger?.info(`access token ${minutesLeft(creds) ?? "?"} min left, asking Claude Code to refresh it`);

	await runClaudeUsage(logger);
	creds = readCredentials();

	if (creds.accessToken && (creds.expiresAt == null || creds.expiresAt > Date.now())) {
		logger?.info(`access token now ${minutesLeft(creds) ?? "?"} min left`);
		return { token: creds.accessToken, hadCredentials: true };
	}

	return { token: null, hadCredentials: creds.exists };
}

/* ------------------------------------------------------------------ */
/* 使用量 API                                                          */
/* ------------------------------------------------------------------ */

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
			key: l.kind === "weekly_all" ? "all" : labelFor(l).toLowerCase() || `w${i}`,
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
export async function getClaudeUsage(manualToken, logger) {
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

	const { token, hadCredentials } = await tokenFromCredentials(logger);

	if (token && token !== manual) {
		try {
			return await requestUsage(token);
		} catch (err) {
			// 期限内のはずなのに弾かれた（取り消された等）→ Claude Code に一度だけ更新させる
			if (!err.authProblem || err.scopeProblem) throw err;

			logger?.info("usage API rejected the token, asking Claude Code to refresh it");
			if (await runClaudeUsage(logger)) {
				const again = readCredentials();
				if (again.accessToken && again.accessToken !== token) return await requestUsage(again.accessToken);
			}
			throw err;
		}
	}

	if (firstError) throw new Error(firstError.scopeProblem ? "SCOPE" : "UNAUTHORIZED");

	// 認証情報はあるのに使えない = 期限切れ。まだ一度もログインしていないのとは区別する。
	throw new Error(hadCredentials ? "UNAUTHORIZED" : "NO_TOKEN");
}
