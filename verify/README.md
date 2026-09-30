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

## 受領証（guardrun）とのつなぎ

`--receipt` は、いまは次の仮の形を受け取る。**guardrun の受領証の本当の形式には
まだ合わせていない**（guardrun はこのリポジトリに入っていないため）。

```json
{"mark": "緑", "exit_code": 0,
 "processes": [["python3", "test_login.py"]],
 "outside_changes": 0}
```

無い項目は「その証拠は無い」として扱い、推測で埋めない。
受領証の実物から上の形へ写す変換を書けば、「テストを実行した」と
「作業場の外を変えていない」が UNVERIFIED から PROVEN / DISPROVEN に動く。

## 試験

```sh
python3 verify/test_proofcheck.py
```

実際に見つかった食い違いを小さな作業場で再現している:
qwc の `sitecustomize.py`、OpenClaw の `conftest.py`、何もせず「達成」、
テスト自体の書き換え、封印の書き換え、作業場に残した FIFO など。

## まだやっていないこと

- 受領証の実物の形式への対応（上）
- claim の分解は規則だけ。言い換えに弱い。LLM を使う分解は、Phase 6 の方針どおり
  semantic として別に記録する形で足す
- 契約の自動生成（Phase 7）と、UNVERIFIED から追加の検証を作ること（Phase 8）
