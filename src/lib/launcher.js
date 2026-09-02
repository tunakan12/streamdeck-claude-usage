import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? "";
const PROGRAMFILES = process.env.ProgramFiles ?? "";

/** シェル経由で起動する（Stream Deck のプロセスからは切り離す） */
function shellRun(command) {
	const child = spawn(command, { shell: true, detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
}

/** 実行ファイルを直接起動する */
function runExe(exe, args = []) {
	const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
}

const CANDIDATES = {
	claude: [
		() => path.join(LOCALAPPDATA, "AnthropicClaude", "claude.exe"),
		() => path.join(LOCALAPPDATA, "Programs", "claude", "Claude.exe"),
		() => path.join(LOCALAPPDATA, "Programs", "Claude", "Claude.exe"),
		() => path.join(PROGRAMFILES, "Claude", "Claude.exe"),
	],
	chatgpt: [
		() => path.join(LOCALAPPDATA, "Programs", "ChatGPT", "ChatGPT.exe"),
		() => path.join(LOCALAPPDATA, "Programs", "chatgpt", "ChatGPT.exe"),
		() => path.join(PROGRAMFILES, "ChatGPT", "ChatGPT.exe"),
		() => path.join(LOCALAPPDATA, "Programs", "Codex", "Codex.exe"),
		() => path.join(LOCALAPPDATA, "Programs", "codex", "Codex.exe"),
	],
};

/** Squirrel 形式（Claude デスクトップ）の Update.exe 経由の起動 */
function squirrelClaude() {
	const updater = path.join(LOCALAPPDATA, "AnthropicClaude", "Update.exe");
	return existsSync(updater) ? { exe: updater, args: ["--processStart", "claude.exe"] } : null;
}

const PROTOCOL = {
	claude: "claude://",
	chatgpt: "chatgpt://",
};

const STORE_APP = {
	// Microsoft Store 版 ChatGPT
	chatgpt: "shell:appsFolder\\OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!App",
};

/**
 * アプリを起動する。
 * @param {"claude"|"chatgpt"} kind
 * @param {string} [customCommand] 設定画面で指定されたコマンド（あれば最優先）
 * @returns {{ok: boolean, how: string}}
 */
export function launch(kind, customCommand) {
	const custom = (customCommand ?? "").trim();
	if (custom) {
		shellRun(`start "" ${custom}`);
		return { ok: true, how: "custom" };
	}

	for (const build of CANDIDATES[kind] ?? []) {
		const exe = build();
		if (exe && existsSync(exe)) {
			runExe(exe);
			return { ok: true, how: exe };
		}
	}

	if (kind === "claude") {
		const sq = squirrelClaude();
		if (sq) {
			runExe(sq.exe, sq.args);
			return { ok: true, how: "squirrel" };
		}
	}

	const proto = PROTOCOL[kind];
	if (proto) {
		shellRun(`start "" "${proto}"`);
		return { ok: true, how: "protocol" };
	}

	const store = STORE_APP[kind];
	if (store) {
		shellRun(`explorer.exe "${store}"`);
		return { ok: true, how: "store" };
	}

	return { ok: false, how: "none" };
}
