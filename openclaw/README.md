# openclaw-config

[OpenClaw](https://github.com/openclaw/openclaw) を Mac の上で「LINE・Discord・ターミナルから話せる
ローカルAI」として動かすための設定一式。ひな形として公開している。

OpenClaw 本体は入っていない（MIT の別プロジェクト。`npm i -g openclaw` で入る）。
ここにあるのは**その上に載せる設定**だけ。

## 何が入っているか

| | 中身 |
| :--- | :--- |
| `openclaw.json.example` | 本体設定。モデル・MCP・チャンネル・スキルの構成 |
| `agents/*.AGENTS.md` | エージェントへの指示書。人格と、道具の使い方の決まりごと |
| `lists/*.txt` | 朝のブリーフィング・SNS の話題・見張るページ・作業を頼める場所 |
| `.env.example` | 鍵のひな形 |
| `install` | `~/.openclaw` に置く |

## 入れ方

```sh
git clone https://github.com/ahogorirappa/openclaw-config
cd openclaw-config
./install          # すでにある実物は上書きしない
./install --force  # 上書きする（先に控えを取る）
./install --check  # 何が置かれているか、埋め忘れが無いか
```

## 鍵とIDは入っていない

**実物の鍵は1つも入っていない。**自分を指すID（LINE / Discord のユーザーIDやチャンネルID）も抜いてある。
その場所には「何を入れるか」が日本語で書いてあるので、置いたあとに手で埋める。

```
DISCORD_BOT_TOKEN=discord bot token please
LINE_CHANNEL_ACCESS_TOKEN=line channel access token please
```

```json
"ownerAllowFrom": ["line:LINE の自分のユーザーIDをここに"]
```

`./install --check` が、ひな形のまま残っている箇所の数を数える。
**埋め忘れると静かに動かない**ので、必ず 0 になるまで確認する。

## パスが `__HOME__` になっている理由

`AGENTS.md` の中で「`~` は使わず絶対パスで書く」と決めている。この環境では `~` を渡すと道具が失敗し、
7分待たされてから落ちるため。しかし絶対パスは入れる人によって違うので、リポジトリでは `__HOME__` にし、
`install` が実行時に埋める。

## これは「戻せる状態」ではない

このリポジトリはひな形であって、**あなたの設定の控えではない。**
壊したときに戻すには、実物そのものを別に記録しておく必要がある（鍵が入るので、非公開の場所に）。

```sh
cd ~/.openclaw && git init && git add -A && git commit -m "いまの状態"
```

用途が違うものを1つにはできない。公開できるものと、鍵の入ったものは、置き場所を分ける。

## 関連

- [openclaw-guards](https://github.com/ahogorirappa/openclaw-guards) — この一式が「落ちずに黙る」のを見つけて直す層
- [qwythos-code](https://github.com/daigo0904/qwythos-code) — ローカルのモデルで動く自律コーディングCLI（`qwc-projects.txt` の相手）
