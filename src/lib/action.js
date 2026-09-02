import { SingletonAction } from "@elgato/streamdeck";

import { formatRemaining, remainingSeconds } from "./format.js";
import { launch } from "./launcher.js";
import { messageDataUri, usageDataUri } from "./render.js";

/** これより長く押したらアプリ起動とみなす */
const LONG_PRESS_MS = 500;

/** 失敗が続いてこれ以上古くなったら、数字を出すのをやめて理由を出す */
const STALE_LIMIT_MS = 30 * 60_000;

const DEFAULTS = {
	pollInterval: 120,
	displayMode: "remaining", // remaining | used
	pressAction: "cycle", // cycle | open | refresh | both
	weeklyScope: "all",
	launchCommand: "",
};

export function normalizeSettings(raw, extra = {}) {
	// Property Inspector は未入力を空文字で送ってくるので、既定値で埋め直す
	const clean = Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== "" && v != null));
	const s = { ...DEFAULTS, ...extra, ...clean };

	const n = Number(s.pollInterval);
	s.pollInterval = Number.isFinite(n) ? Math.max(30, Math.min(3600, n)) : DEFAULTS.pollInterval;

	if (s.displayMode !== "used") s.displayMode = "remaining";
	if (!["cycle", "open", "refresh", "both"].includes(s.pressAction)) s.pressAction = DEFAULTS.pressAction;
	s.launchCommand = String(s.launchCommand ?? "");

	return s;
}

/**
 * 5時間 / 週の残量を 1 キーに 2 段で表示する共通アクション。
 * データ取得は service、アプリ起動は launcher に任せる。
 *
 * 設定はキーごとにキャッシュしておく。描画のたびに getSettings() を呼ぶと
 * didReceiveSettings が返ってきて再描画 → 無限ループになるため。
 */
export class UsageAction extends SingletonAction {
	constructor({ manifestId, title, accent, appKind, service, extraDefaults = {}, describeError }) {
		super();
		this.manifestId = manifestId;
		this.title = title;
		this.accent = accent;
		this.appKind = appKind;
		this.service = service;
		this.extraDefaults = extraDefaults;
		this.describeError = describeError ?? (() => ["ERROR"]);

		/** @type {Map<string, {action:any, settings:any, unsubscribe:() => void}>} */
		this.keys = new Map();
		this.ticker = null;
	}

	onWillAppear(ev) {
		if (!ev.action.isKey()) return;

		const settings = normalizeSettings(ev.payload.settings, this.extraDefaults);
		this.apply(settings);

		this.keys.get(ev.action.id)?.unsubscribe();
		const entry = { action: ev.action, settings, unsubscribe: () => {} };
		this.keys.set(ev.action.id, entry);

		entry.unsubscribe = this.service.subscribe((state) => void this.render(entry, state));
		this.startTicker();
	}

	onWillDisappear(ev) {
		this.keys.get(ev.action.id)?.unsubscribe();
		this.keys.delete(ev.action.id);

		if (this.keys.size === 0 && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	async onDidReceiveSettings(ev) {
		const entry = this.keys.get(ev.action.id);
		if (!entry) return;

		entry.settings = normalizeSettings(ev.payload.settings, this.extraDefaults);
		this.apply(entry.settings);

		await this.service.refresh({ force: true });
		await this.render(entry, this.service.state);
	}

	onKeyDown(ev) {
		const entry = this.keys.get(ev.action.id);
		if (entry) entry.pressedAt = Date.now();
	}

	async onKeyUp(ev) {
		const entry = this.keys.get(ev.action.id);
		const settings = entry?.settings ?? normalizeSettings(ev.payload?.settings, this.extraDefaults);
		const held = entry?.pressedAt ? Date.now() - entry.pressedAt : 0;

		// 表示切替モードでは、短押しで下段を切り替え、長押し（0.5秒〜）でアプリを起動する
		if (settings.pressAction === "cycle" && held < LONG_PRESS_MS && entry) {
			if (this.cycleScope(entry)) return;
		}

		if (settings.pressAction !== "refresh") {
			try {
				launch(this.appKind, settings.launchCommand);
			} catch (err) {
				this.service.logger?.error("launch failed", err);
				await ev.action.showAlert();
			}
		}

		const state = await this.service.refresh({ force: true });
		if (settings.pressAction === "refresh") await (state.status === "ok" ? ev.action.showOk() : ev.action.showAlert());
	}

	/** 下段に出す週ウィンドウを次のものへ送る。切り替え先が無ければ false */
	cycleScope(entry) {
		const windows = this.service.state.windows ?? [];
		if (windows.length < 2) return false;

		const current = windows.findIndex((w) => w.key === entry.settings.weeklyScope);
		const next = windows[(current + 1 + windows.length) % windows.length];

		entry.settings = { ...entry.settings, weeklyScope: next.key };
		void entry.action.setSettings(entry.settings);
		void this.render(entry, this.service.state);

		return true;
	}

	/** サービス側（取得間隔・トークンなど）へ設定を渡す */
	apply(settings) {
		this.service.configure?.(settings);
		this.service.setInterval(settings.pollInterval);
	}

	/** 取得の合間も「あと何分」を進めるため、30 秒ごとに描き直す */
	startTicker() {
		if (this.ticker) return;

		this.ticker = setInterval(() => {
			for (const entry of this.keys.values()) void this.render(entry, this.service.state);
		}, 30_000);
	}

	async render(entry, state) {
		const { action, settings } = entry;

		// 一度でも取れていれば、失敗中でも最後の値を出し続ける（ヘッダーの * が目印）。
		// ただし古くなりすぎたら、黙って嘘の数字を出すより理由を見せる。
		const tooOld = state.status === "error" && state.fetchedAt != null && Date.now() - state.fetchedAt > STALE_LIMIT_MS;

		if (state.session == null || tooOld) {
			const lines = state.status === "error" ? this.describeError(state.error ?? "") : ["...", ""];
			await action.setImage(messageDataUri({ title: this.title, accent: this.accent, lines }));
			return;
		}

		const windows = state.windows ?? (state.weekly ? [{ key: "all", label: "7D", ...state.weekly }] : []);
		const weekly = windows.find((w) => w.key === settings.weeklyScope) ?? windows[0] ?? null;
		const session = state.session;

		await action.setImage(
			usageDataUri({
				title: this.title,
				accent: this.accent,
				showUsed: settings.displayMode === "used",
				stale: Boolean(state.stale),
				weeklyLabel: weekly?.label ?? "7D",
				session: {
					remaining: session?.remaining ?? null,
					resetText: formatRemaining(remainingSeconds(session?.resetAt)),
				},
				weekly: {
					remaining: weekly?.remaining ?? null,
					resetText: formatRemaining(remainingSeconds(weekly?.resetAt)),
				},
			}),
		);
	}
}
