# Stream Deck — Claude Usage

Claude の残量を Stream Deck のキー 1 枚に表示します。上段が 5 時間ウィンドウ、下段が週ウィンドウ、それぞれの下にリセットまでの残り時間が出ます。

[English README](README.md)

![キーの表示例](docs/keys.png)

## 表示の見かた

| 行 | 意味 |
| --- | --- |
| `5H` | 5 時間ウィンドウ |
| `7D` | 週ウィンドウ（全モデル合計） |
| バー | 使用量ではなく**残量** |
| バー下の小さい文字 | そのウィンドウがリセットされるまでの時間（`1h41m`、`3d15h`） |

色は残量に対応します。50 % 超で緑、50 % 以下で黄、25 % 以下でオレンジ、10 % 以下で赤。

モデル別の週枠（Opus / Sonnet / Fable など）がプランにある場合、**短押しで下段が切り替わります** — `7D` → `FABLE` → `7D`。選んだ状態はキーごとに保存されます。**長押し（0.5 秒以上）** で Claude デスクトップアプリが起動し、同時に即時更新します。

## 動作環境

- Windows 10 以降
- Stream Deck ソフトウェア 6.6 以降（必要な Node.js 20 ランタイムが同梱されています）
- Claude Code CLI にログイン済みであること

## インストール

1. このリポジトリを **Code → Download ZIP** でダウンロードして展開します。
2. `com.yuya.claudeusage.sdPlugin` フォルダを次の場所にコピーします。
   ```
   %APPDATA%\Elgato\StreamDeck\Plugins\
   ```
3. Stream Deck を**完全に終了**します（タスクトレイのアイコンを右クリック →「終了」。ウィンドウの ✕ だけでは常駐したままです）。そのあと起動し直します。
4. **Claude Usage → Claude 残量** をキーにドラッグします。

## 認証

PowerShell で `claude` を一度起動してログインしてください。プラグインは
`%USERPROFILE%\.claude\.credentials.json` を読み、期限が切れたら自分でリフレッシュして
同じファイルに書き戻します（CLI 側もそのまま使えます）。

> `claude setup-token` で発行したトークンは**使えません**。推論用のスコープしか持たず、
> 使用量エンドポイントに `OAuth token does not meet scope requirement user:profile`
> で弾かれます。

設定のトークン欄は任意です。別アカウントの OAuth トークンを使いたいときだけ入力します。

## 設定項目

| 項目 | 既定値 | 補足 |
| --- | --- | --- |
| トークン | 空 | 空のままで Claude Code のログイン情報を使います |
| 更新間隔 | 3 分 | エンドポイントの制限が厳しいので 3 分以上を推奨 |
| 表示 | 残り % | 使用 % に切り替えられます |
| 押したとき | 短押し＝切替 / 長押し＝起動 | ほかに「起動＋更新」「起動のみ」「更新のみ」 |
| 起動コマンド | 空 | 空なら Claude デスクトップアプリを自動検出します |
| ログイン用コマンド | 空 | ログインエラー表示中にキーを押すと実行。空なら `claude` |

## ソースからビルドする

```bash
npm install
npm run build   # src/ を com.yuya.claudeusage.sdPlugin/bin/plugin.js にまとめます
```

`npm run watch` で変更を監視します。ツールチェーン無しでも入れられるよう、
ビルド済みのファイルはリポジトリに含めてあります。

## データの取得方法

OAuth アクセストークンで `GET https://api.anthropic.com/api/oauth/usage` を叩き、
レスポンスの `limits` 配列を読みます。`kind: "session"` が上段、`group: "weekly"` の
各要素が下段の 1 ページになります（ラベルは `scope.model.display_name`）。

**このエンドポイントは Anthropic が公開・サポートしているものではありません。**
予告なく変わったり無くなったりする可能性があります。本プラグインは Anthropic とも
Elgato とも無関係です。通信先は Anthropic の API のみで、トークンが外部に出ることは
ありません。

## うまくいかないとき

| キーの表示 | 意味 |
| --- | --- |
| `NO LOGIN` | 認証情報がありません。**キーを押す**とターミナルで `claude` が起動します |
| `BAD SCOPE` | 設定のトークンに `user:profile` がありません。空にしてキーを押してください |
| `AUTH EXPIRED` | 更新に失敗しました。**キーを押す**とターミナルで `claude` が起動します |
| `RATE LIMITED` | 叩きすぎです。5 分待って再試行します |
| `OFFLINE` | 通信に失敗しました。次の更新で再試行します |

一度数字が出たあとに取得へ失敗した場合は、エラー表示に置き換えず、直前の値をタイトル横の
`*` 付きで出し続けます。30 分以上取得できないままだと、数字をやめて理由を表示します。

ログは `com.yuya.claudeusage.sdPlugin/logs/` にあります。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
