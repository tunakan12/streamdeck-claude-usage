/**
 * 使用量の取得をまとめる小さなサービス。
 * キーが何枚置かれても取得は 1 本にまとめ、結果を購読者へ配る。
 */
export class UsageService {
	#subscribers = new Set();
	#timer = null;
	#intervalSec = 120;
	#inflight = null;
	#backoffUntil = 0;

	/** @type {{status:"init"|"ok"|"error", session:any, weekly:any, fetchedAt:number|null, stale:boolean, error:string|null}} */
	state = { status: "init", session: null, weekly: null, fetchedAt: null, stale: false, error: null };

	/** @param {() => Promise<{session:any, weekly:any, stale?:boolean}>} fetcher */
	constructor(fetcher, logger) {
		this.fetcher = fetcher;
		this.logger = logger;
	}

	subscribe(fn) {
		this.#subscribers.add(fn);
		fn(this.state);

		if (this.#subscribers.size === 1) this.#start();
		else if (this.state.status === "init") void this.refresh();

		return () => {
			this.#subscribers.delete(fn);
			if (this.#subscribers.size === 0) this.#stop();
		};
	}

	setInterval(seconds) {
		const next = Math.max(30, Math.min(3600, Number(seconds) || 120));
		if (next === this.#intervalSec) return;

		this.#intervalSec = next;
		if (this.#timer) this.#start();
	}

	#start() {
		this.#stop();
		void this.refresh();
		this.#timer = setInterval(() => void this.refresh(), this.#intervalSec * 1000);
	}

	#stop() {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	#emit() {
		for (const fn of this.#subscribers) {
			try {
				fn(this.state);
			} catch (err) {
				this.logger?.error("subscriber failed", err);
			}
		}
	}

	async refresh({ force = false } = {}) {
		if (this.#inflight) return this.#inflight;
		if (!force && Date.now() < this.#backoffUntil) return this.state;

		this.#inflight = (async () => {
			try {
				const result = await this.fetcher();
				this.state = {
					...result,
					status: "ok",
					fetchedAt: Date.now(),
					stale: Boolean(result.stale),
					error: null,
				};
				this.#backoffUntil = 0;
			} catch (err) {
				const message = err?.message ?? String(err);
				this.logger?.warn(`usage fetch failed: ${message}`);

				// 連続失敗でエンドポイントを叩き続けないよう少し待つ
				this.#backoffUntil = Date.now() + (/\b429\b/.test(message) ? 300_000 : 60_000);
				this.state = { ...this.state, status: "error", error: message };
			} finally {
				this.#inflight = null;
			}

			this.#emit();
			return this.state;
		})();

		return this.#inflight;
	}
}
