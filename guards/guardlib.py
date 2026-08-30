"""guardlib — 見張りたちが共有する部品。

## なぜ共有に変えたか

もとは同じコードを4つの見張りに書き写していた。理由は
「共通の部品が壊れると、見張りが揃って黙る」だった。

その考えは間違っていた。実際に起きたのは逆で、

  - 2026-08-30、watchdog を編集したときに beat と pulse_age を巻き込んで消し、
    NameError で落ちた。書き写しを導入したその日のうちに事故になった。
  - 同じ日に数えたら env_value は10ファイル、notify は6ファイルに増えていた。
  - 4つの beat のうち line-guard だけ既に中身がずれていた。ずれていたのは
    「わざと共有していない」と主張している説明文そのものだった。

**独立は、同じ文字列を別々に持つことでは買えない。**
見張りの独立を支えているのは、4つが別のプロセス・別の時計・別の判断で
動いていることであって、コードが別の場所に書いてあることではない。

## 共有したもの / しなかったもの

共有したのは、判断を含まない道具だけ（ファイルの読み書き、通知、鍵）。
**「何を見るか」「いつ手を出すか」は各見張りが自分で持っている。**
そこを共有すると、1つの判断ミスが4つに同時に効くので、そちらは今も分けてある。

## 単一障害点であることは認める

このファイルが壊れれば4つとも起動しない。書き写しはその危険を避けていた。
代わりに置いたのが下の selftest で、install が入れるたびに走らせる。
**重複で守るのではなく、検査で守る**に切り替えた、という整理になる。

    python3 guardlib.py --selftest
"""

import fcntl
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime

OPENCLAW = os.path.expanduser("~/.openclaw")
ENV_FILE = os.path.join(OPENCLAW, ".env")
PULSE_DIR = os.path.join(OPENCLAW, "pulse")
LOG_DIR = os.path.join(OPENCLAW, "logs")
PLIST_DIR = os.path.expanduser("~/Library/LaunchAgents")


def env_value(key):
    """環境変数、無ければ ~/.openclaw/.env から拾う。

    鍵や自分を指すIDをコードに直書きしないための入り口。
    launchd から走るときは環境変数が渡らないので、ファイルからも読む。"""
    v = os.environ.get(key)
    if v:
        return v.strip()
    try:
        for row in open(ENV_FILE):
            row = row.strip()
            if row.startswith(f"{key}="):
                return row.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def pulse_age(name):
    """その見張りが最後に走り切ってから何秒たったか。一度も走っていなければ None。"""
    try:
        with open(os.path.join(PULSE_DIR, f"{name}.json")) as f:
            at = datetime.fromisoformat(json.load(f)["at"])
        return (datetime.now() - at).total_seconds()
    except (OSError, ValueError, KeyError, TypeError):
        return None


def kickstart(label):
    """蹴り直す。**読み込まれていない plist は蹴れない**ので、そのときは読み込む。

    ここは一度、直っていないのに「入れ直した」と記録していた。
    launchctl kickstart は plist が外れていると
    `Could not find service ... in domain for user gui` で失敗するだけで、
    戻り値を捨てていたため、ログにだけ復旧したと書き残っていた。
    **嘘をつく見張りは、居ないより悪い。**"""
    r = subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{label}"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return True
    plist = os.path.join(PLIST_DIR, f"{label}.plist")
    if not os.path.exists(plist):
        return False
    b = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", plist],
                       capture_output=True, text=True)
    return b.returncode == 0


class Guard:
    """1つの見張りが持つ、記録・通知・心拍・鍵。

    置き場所は名前から決まる（~/.openclaw/logs/<名前>.log など）。
    見張りを1つ足すたびにパスを4本書くのをやめるため。"""

    def __init__(self, name):
        self.name = name
        self.log_path = os.path.join(LOG_DIR, f"{name}.log")
        self.state_path = os.path.join(OPENCLAW, f"{name}-state.json")
        self.lock_path = os.path.join(OPENCLAW, f"{name}.lock")
        self._lock = None

    # ── 記録 ──────────────────────────────
    def log(self, msg):
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(self.log_path, "a") as f:
                f.write(f"[{stamp}] {msg}\n")
        except OSError:
            pass

    # ── 通知 ──────────────────────────────
    def notify(self, text):
        """Discord に一言送る。

        宛先が分からないときは**黙って捨てず**ログに残す。
        見張りの知らせが届かないうえ、届いていないことすら分からないのが一番困る。
        gateway を通さず discord.com を直接叩くのは、
        gateway が死んでいるときにこそ知らせたいから。"""
        tok = env_value("DISCORD_BOT_TOKEN")
        channel = env_value("DISCORD_CHANNEL_ID")
        if not tok or not channel:
            self.log("通知先が設定されていない（DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID）: " + text)
            print(text)
            return
        body = json.dumps({"content": text[:1950]}).encode()
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{channel}/messages",
            data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bot {tok}",
                     "User-Agent": f"{self.name} (local, 1.0)"},
        )
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except Exception:
            self.log("Discord に送れなかった: " + text.splitlines()[0])

    # ── 心拍 ──────────────────────────────
    def beat(self):
        """「今回ちゃんと走り切った」という跡を残す。ほかの見張りがこれを見る。

        失敗した回にも残す。相手が答えないことと、見張りが死んだことは別で、
        取り違えると直す相手を間違える。"""
        try:
            os.makedirs(PULSE_DIR, exist_ok=True)
            with open(os.path.join(PULSE_DIR, f"{self.name}.json"), "w") as f:
                json.dump({"at": datetime.now().isoformat(timespec="seconds")}, f)
        except OSError:
            pass

    # ── 覚え書き ──────────────────────────
    def load_state(self):
        try:
            with open(self.state_path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_state(self, state):
        try:
            os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
            with open(self.state_path, "w") as f:
                json.dump(state, f, ensure_ascii=False)
        except OSError:
            pass

    # ── 鍵 ────────────────────────────────
    def hold_lock(self):
        """同時に2つ走らないようにする。取れなければ False。

        手で走らせたぶんと launchd の定期実行が重なり、両方が「連続3回」と
        数えて gateway を2回入れ直したことがある。見張りが2つ同時に手を出すと、
        直すつもりで壊すことになる。"""
        try:
            f = open(self.lock_path, "w")
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock = f          # プロセスが終わるまで握っておく
            return True
        except (OSError, BlockingIOError):
            return False


def selftest():
    """このファイルが壊れていないかを、書き捨ての場所で確かめる。

    共有にした代わりに置いた検査。install が入れるたびに走らせる。"""
    import tempfile
    global OPENCLAW, PULSE_DIR, LOG_DIR
    keep = (OPENCLAW, PULSE_DIR, LOG_DIR)
    tmp = tempfile.mkdtemp(prefix="guardlib-test-")
    ok = []
    try:
        OPENCLAW = tmp
        PULSE_DIR = os.path.join(tmp, "pulse")
        LOG_DIR = os.path.join(tmp, "logs")

        g = Guard("selftest")
        g.log_path = os.path.join(LOG_DIR, "selftest.log")
        g.state_path = os.path.join(tmp, "selftest-state.json")
        g.lock_path = os.path.join(tmp, "selftest.lock")

        g.beat()
        age = pulse_age("selftest")
        ok.append(("心拍を書いて読める", age is not None and age < 5))

        g.save_state({"a": 1})
        ok.append(("覚え書きが往復する", g.load_state().get("a") == 1))

        g.log("テスト")
        ok.append(("記録が書ける", os.path.exists(g.log_path)))

        ok.append(("鍵が取れる", g.hold_lock() is True))

        ok.append(("無い心拍は None", pulse_age("いない見張り") is None))
        ok.append(("無い鍵は None を返す", env_value("ZZ_NOT_A_REAL_KEY") is None))
    finally:
        OPENCLAW, PULSE_DIR, LOG_DIR = keep
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    bad = [n for n, r in ok if not r]
    for n, r in ok:
        print(f"  {'ok  ' if r else 'NG  '}{n}")
    print(f"\n  {len(ok) - len(bad)} / {len(ok)} 件")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else 0)
