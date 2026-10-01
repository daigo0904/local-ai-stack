# verify — 「できました」を証拠と突き合わせる

エージェントの完了報告を信じずに、実行の証拠から**どこまで達成されたと言えるか**を
PROVEN / DISPROVEN / UNVERIFIED の三値で判定する。

guardrun（壁）と受領証は「走りがどう終わったか」を言う。
`proofcheck` はその上に載り、「頼んだ仕事がどこまで終わったと証明できるか」を言う。
ロードマップの Phase 2（Claim-Evidence Verifier）・Phase 3（Verification Contract）・
Phase 4（三値判定）の最初の実装にあたる。

## 使い方

```sh
# 1. 実行の前に、成功の条件（契約）と作業場を封印する
proofcheck seal contract.json --workspace ~/work/login --run ~/.proofcheck/run-001
#   → 封印ID が出る。控えておく

# 2. エージェントに仕事をさせる（guardrun の中で）

# 3. 申告を渡して判定する
proofcheck judge ~/.proofcheck/run-001 --seal-id <封印ID> \
  --claim "auth.py を修正し、テストを実行し、すべて通りました。バグを直しました。" \
  [--receipt receipt.json]
```

終了コードは PROVEN=0・DISPROVEN=1・UNVERIFIED=2・判定できない=3。
結果は `RUNDIR/report.json` にも残る。

## 契約（Verification Contract）

```json
{
  "task": "ログインバグを修正",
  "repro": ["python3 test_login.py"],
  "keep_passing": ["python3 test_other.py"],
  "may_change": ["auth.py"],
  "must_not_change": ["test_*.py"],
  "timeout_sec": 120
}
```

| 項目 | 意味 |
| --- | --- |
| `repro` | 修正前に落ち、修正後に通るべきテスト。「バグが直った」を PROVEN にできるのはこれだけ |
| `must_pass` | 修正後に通るべきテスト |
| `keep_passing` | もともと通っていて、今も通るべきテスト（regression） |
| `may_change` | 変えてよい場所。空なら「どこも変えてはいけない」 |
| `must_not_change` | 変えてはいけない場所。テスト自体など |
| `ignore` | 差分に数えない場所（`__pycache__` などは最初から除く） |

知らない項目があると封印しない。綴りを誤った条件が黙って消えるのを防ぐため。
封印のあとで作業場の契約ファイルを書き換えても、判定は封印した契約で行う。

## 判定のしかた

- **申告を atomic claim に分ける。** 「変更した」「テストを走らせた」「通った」「直った」
  「その他の完了」の5種類。規則による分解で、意味は読まない。
- **テストは proofcheck が自分で走らせる。** 作業場の写しの上で、`must_not_change` に
  当たるものと、試験の結果を変えられるフック（`sitecustomize.py`・`conftest.py`・`*.pth`・
  `pytest.ini`・`package.json` など）を封印時の姿に戻してから走らせる。
  環境変数 `PYTHONPATH`・`NODE_OPTIONS`・`LD_PRELOAD` なども渡さない。
- **証拠の無い claim は PROVEN にしない。** UNVERIFIED にして、足りない証拠を書く。
- **各判定に deterministic / semantic を付ける。** 「直った」は再現テストに委ねた
  semantic な判定で、そのことを隠さない。

| claim | 証拠 | 証拠が無いとき |
| --- | --- | --- |
| ファイルを変更した | 封印時との差分 | —（差分は必ず取れる） |
| テストを実行した | 受領証の命令の記録 | UNVERIFIED |
| テストが通った | proofcheck 自身の実行（テストとフックを戻した写しで） | UNVERIFIED（契約にテストが無い） |
| バグが解消された | 再現テストが修正前に落ち、修正後に通る | UNVERIFIED（`repro` が無い） |
| その他の完了 | 定義していない | UNVERIFIED |

## 保証すること / しないこと

保証する:

- 作業場の中で、封印してから何が変わったか（ファイル・リンク・FIFO などの特殊ファイル）
- 契約のテストが、テストとフックを元に戻した状態で通るか
- 再現テストが「修正前に落ち、修正後に通る」か

保証しない:

- 作業場の外で起きたこと。guardrun の受領証が要る
- エージェントが本当にテストを走らせたか。これも受領証が要る
- テストが仕様を十分に覆っているか。「直った」は再現テストの出来に依存する
- RUNDIR 自体の改竄。RUNDIR はエージェントの届かない場所（作業場の外・guardrun が
  書かせない場所）に置き、封印IDを `--seal-id` で渡す。違えば判定しない
- テストの中身の正しさ。proofcheck は終了コードしか見ない

## Codex のハーネスとつなぐ（agent-run・claw run）

OpenAI が [openai/codex](https://github.com/openai/codex) で公開しているハーネス
（`codex exec`）は、走らせた命令と終わり方を `--json` で JSONL に出す。
qwc も `qwc -p … --events FILE` で同じ形を書くようにした。
proofcheck は `--codex-jsonl` でこの記録を読み、エージェントの最後の発言を申告として使う。

```sh
# Codex に頼む（外の API に出ず、この Mac の ollama で動かす）
claw run --agent codex --contract login.json "ログインバグを直して"
# qwc に頼む
claw run --contract login.json "ログインバグを直して"
```

`claw run` は ollama が起きているか確かめてから `agent-run` に任せる。`agent-run` は
封印 → 実行 → 判定を通し、記録を `~/.openclaw/runs/<日時>-<エージェント>/` に置く。
Codex は `codex exec --oss --local-provider ollama --sandbox workspace-write --json` で走らせる。

| 記録から分かること | 分からないこと |
| --- | --- |
| 走らせた命令と終了コード（「テストを実行した」の証拠） | 作業場の外の変化（受領証が要る） |
| エージェント自身の最後のテスト実行がどう終わったか | 記録そのものが書き換えられていないこと |

記録はハーネス（Codex や qwc）が自分で見た事実で、モデルの文よりは強いが、
カーネルの記録ほど強くはない。だから受領証と両方あるときは受領証を優先する。
記録は作業場の外に書かせる（agent-run はそうしている）。

まだ確かめていないこと: 本物の `codex` を ollama の gemma4 で動かすこと。
試験（`verify/test_agent_run.py`）は、本物と同じ引数を受け取り同じ形の記録を出す偽物で通している。

## 受領証（guardrun）とのつなぎ

`--receipt` に guardrun の受領証（`~/.guardrun/runs/<id>/受領証.json`、または
`guardrun.py <作業場> <命令…>` が最後に出す JSON）をそのまま渡す。形式版2 の
`期待`・`事後.照合` があれば report.json に残す。

| 受領証から言えること | 契約の行 |
| --- | --- |
| 判定が緑・青・赤・失敗（壁の内側で最後まで見届けた）なら、作業場の外への書き込みは壁が断っている | `outside` を PROVEN（**測った数ではなく壁の保証**。古いカーネルや Windows では境界が狭い） |
| 判定そのもの | `guardrun_mark`：緑・青 → PROVEN、赤 → DISPROVEN、失敗・中断・拒否 → UNVERIFIED |
| 受領証の差分 | `two_diffs`：proofcheck の封印からの差分と突き合わせる。食い違えば DISPROVEN（どちらかが間違っている） |

**受領証に、壁の中で走った1本1本の命令は無い。**受領証の「命令」はエージェント全体を
起動した1本だけなので、「テストを実行した」の証拠にはならない。そちらは `--codex-jsonl`
（ハーネスの記録）が担う。両方渡すと、申告も契約も全部が PROVEN になりうる。

受領証の作業場が封印した作業場と違えば、判定しない（別の走りの差分で採点しないため）。

まだできていないこと: `agent-run` を guardrun の壁の中で走らせること。壁は作業場の外への
書き込みを断るので、エージェントの手が届かない場所にハーネスの記録を書けない。
guardrun に「記録の書き出し先」を足す変更が要る。

## 試験

```sh
python3 verify/test_proofcheck.py
python3 verify/test_agent_run.py
```

実際に見つかった食い違いを小さな作業場で再現している:
qwc の `sitecustomize.py`、OpenClaw の `conftest.py`、何もせず「達成」、
テスト自体の書き換え、封印の書き換え、作業場に残した FIFO など。

## まだやっていないこと

- 受領証の実物の形式への対応（上）
- claim の分解は規則だけ。言い換えに弱い。LLM を使う分解は、Phase 6 の方針どおり
  semantic として別に記録する形で足す
- 契約の自動生成（Phase 7）と、UNVERIFIED から追加の検証を作ること（Phase 8）
