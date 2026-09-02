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
	if (message.includes("NO_TOKEN")) return ["NO LOGIN", "run: claude", "and log in"];
	if (message.includes("SCOPE")) return ["BAD SCOPE", "clear token,", "run: claude"];
	if (message.includes("UNAUTHORIZED")) return ["AUTH", "EXPIRED", "run: claude"];
	if (message.includes("429")) return ["RATE", "LIMITED"];
	return ["OFFLINE", "retrying"];
}

streamDeck.actions.registerAction(
	new UsageAction({
		manifestId: "com.yuya.claudeusage.limits",
		title: "CLAUDE",
		accent: "#D97757",
		appKind: "claude",
		service,
		extraDefaults: { pollInterval: 180, apiToken: "" },
		describeError,
	}),
);

await streamDeck.connect();
