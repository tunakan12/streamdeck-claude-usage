import { build, context } from "esbuild";

/** Stream Deck に同梱の Node.js 20 で動く 1 ファイルにまとめる */
const options = {
	entryPoints: ["src/plugin.js"],
	outfile: "com.yuya.claudeusage.sdPlugin/bin/plugin.js",
	bundle: true,
	minify: true,
	platform: "node",
	format: "esm",
	target: "node20",
	// ws のオプショナルなネイティブ依存はバンドルしない
	external: ["bufferutil", "utf-8-validate"],
	banner: { js: 'import{createRequire as __cr}from "node:module";const require=__cr(import.meta.url);' },
};

if (process.argv.includes("--watch")) {
	const ctx = await context(options);
	await ctx.watch();
	console.log("watching...");
} else {
	await build(options);
	console.log(`built ${options.outfile}`);
}
