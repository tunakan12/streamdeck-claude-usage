import streamDeck from "@elgato/streamdeck";

import { UsageAction } from "./lib/action.js";
import { UsageService } from "./lib/service.js";
import { getClaudeUsage } from "./usage.js";

streamDeck.logger.setLevel("info");

/** Property Inspector に入力されたトークン（空なら Claude Code のログイン情報を使う） */
let manualToken = "";

const service = new UsageService(() => getClaudeUsage(manualToken), streamDeck.logger);
service.configure = (settings) => {
	manualToken = settings.apiToken ?? "";
};

function describeError(message) {
	if (message.includes("NO_TOKEN")) return ["NO LOGIN", "press key", "to sign in"];
	if (message.includes("SCOPE")) return ["BAD SCOPE", "clear token,", "press key"];
	if (message.includes("UNAUTHORIZED")) return ["AUTH EXPIRED", "press key", "to sign in"];
	if (message.includes("429")) return ["RATE", "LIMITED"];
	return ["OFFLINE", "retrying"];
}

/** 認証が切れているときは、押したら claude を開いてその場でログインできるようにする */
const recovery = { match: /NO_TOKEN|UNAUTHORIZED|SCOPE/, command: "claude" };

streamDeck.actions.registerAction(
	new UsageAction({
		manifestId: "com.yuya.claudeusage.limits",
		title: "CLAUDE",
		accent: "#D97757",
		appKind: "claude",
		service,
		extraDefaults: { pollInterval: 180, apiToken: "" },
		describeError,
		recovery,
	}),
);

await streamDeck.connect();
