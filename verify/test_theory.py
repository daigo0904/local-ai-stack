#!/usr/bin/env python3
"""判定の核（decide）と --fast が、定式化.md に書いた性質を満たすかを確かめる。

    python3 verify/test_theory.py

性質は「いくつかの例で通る」では足りないので、証拠の組をランダムに大量に作って当てる。
乱数の種は固定してあるので、落ちたら同じ組で再現できる。
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import itertools
import json
import os
import random
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("proofcheck", os.path.join(HERE, "proofcheck"))
_spec = importlib.util.spec_from_loader("proofcheck", _loader)
pc = importlib.util.module_from_spec(_spec)
_loader.exec_module(pc)

KINDS = list(pc.EVIDENCE_KINDS)
CLAIMS = list(pc.CLAIM_REQUIREMENTS)
STRENGTHS = [pc.HARNESS, pc.VERIFIER, pc.KERNEL]
N = 4000


def random_evidence(rng, n=None):
    n = rng.randint(0, 6) if n is None else n
    return [pc.ev(rng.choice(KINDS), rng.choice("+-?"), rng.choice(STRENGTHS), "乱数", f"e{i}")
            for i in range(n)]


def admissible(e, claim):
    req = pc.CLAIM_REQUIREMENTS[claim][0]
    return e["kind"] in req and e["stance"] in "+-" and e["strength"] >= pc.EVIDENCE_KINDS[e["kind"]][0]


class DecideProperties(unittest.TestCase):
    def setUp(self):
        self.rng = random.Random(20261001)

    def test_P1_no_evidence_is_never_decided(self):
        """P1 証拠が無ければ、どの主張も UNVERIFIED（勝手に TRUE にしない）。"""
        for k in CLAIMS:
            self.assertEqual(pc.decide(k, [])["verdict"], pc.UNVERIFIED, k)

    def test_P2_proven_is_sound(self):
        """P2 PROVEN なら、要る種類が全部「強さの足りる +」で埋まり、強さの足りる「-」は1つも無い。"""
        for _ in range(N):
            k = self.rng.choice(CLAIMS)
            E = random_evidence(self.rng)
            if pc.decide(k, E)["verdict"] != pc.PROVEN:
                continue
            req = pc.CLAIM_REQUIREMENTS[k][0]
            self.assertTrue(req)
            for kind in req:
                self.assertTrue(any(e["kind"] == kind and e["stance"] == "+" and admissible(e, k) for e in E))
            self.assertFalse(any(e["stance"] == "-" and admissible(e, k) for e in E))

    def test_P3_order_does_not_matter(self):
        """P3 証拠の並びを入れ替えても、判定・決め手・足りないものは同じ。"""
        for _ in range(N // 4):
            k = self.rng.choice(CLAIMS)
            E = random_evidence(self.rng, self.rng.randint(0, 5))
            want = pc.decide(k, E)
            for perm in itertools.islice(itertools.permutations(E), 6):
                got = pc.decide(k, list(perm))
                self.assertEqual((got["verdict"], got["trust"], sorted(got["missing"])),
                                 (want["verdict"], want["trust"], sorted(want["missing"])))

    def test_P4_weak_evidence_changes_nothing(self):
        """P4 強さの足りない証拠・関係の無い種類の証拠を足しても、判定は変わらない。"""
        for _ in range(N):
            k = self.rng.choice(CLAIMS)
            E = random_evidence(self.rng)
            extra = [e for e in random_evidence(self.rng, 3) if not admissible(e, k)]
            self.assertEqual(pc.decide(k, E)["verdict"], pc.decide(k, E + extra)["verdict"])

    def test_P5_contradiction_blocks_proven(self):
        """P5 強さの足りる「-」を1つ足せば、何があっても PROVEN にはならない。"""
        for _ in range(N):
            k = self.rng.choice([c for c in CLAIMS if pc.CLAIM_REQUIREMENTS[c][0]])
            kind = self.rng.choice(pc.CLAIM_REQUIREMENTS[k][0])
            minimum = pc.EVIDENCE_KINDS[kind][0]
            neg = pc.ev(kind, "-", self.rng.choice([s for s in STRENGTHS if s >= minimum]), "乱数", "neg")
            self.assertNotEqual(pc.decide(k, random_evidence(self.rng) + [neg])["verdict"], pc.PROVEN)

    def test_P6_support_never_flips_disproven_to_proven(self):
        """P6 DISPROVEN に「+」を足しても PROVEN にはならない（せいぜい食い違いの UNVERIFIED）。"""
        for _ in range(N):
            k = self.rng.choice(CLAIMS)
            E = random_evidence(self.rng)
            if pc.decide(k, E)["verdict"] != pc.DISPROVEN:
                continue
            more = E + [pc.ev(self.rng.choice(KINDS), "+", pc.KERNEL, "乱数", "pos") for _ in range(3)]
            self.assertIn(pc.decide(k, more)["verdict"], (pc.DISPROVEN, pc.UNVERIFIED))

    def test_P7_undefined_claims_are_never_proven(self):
        """P7 証拠の定義が無い主張（other）は、どんな証拠があっても PROVEN にならない。"""
        for _ in range(N // 4):
            E = [pc.ev(k, "+", pc.KERNEL, "乱数", "pos") for k in KINDS]
            self.assertEqual(pc.decide("other", E + random_evidence(self.rng))["verdict"], pc.UNVERIFIED)

    def test_P8_trust_is_the_weakest_used(self):
        """P8 決め手（trust）は、判定に使った証拠のうち一番弱いものの強さ。"""
        for _ in range(N):
            k = self.rng.choice(CLAIMS)
            r = pc.decide(k, random_evidence(self.rng))
            if r["used"]:
                self.assertEqual(r["trust"], min(e["strength"] for e in r["used"]))
            else:
                self.assertIsNone(r["trust"])

    def test_conflict_is_reported_not_resolved(self):
        """食い違いはどちらかに決めない。UNVERIFIED にして、食い違いだと書く。"""
        r = pc.decide("tests_passed", [pc.ev("test_result", "+", pc.VERIFIER, "a", "通った"),
                                       pc.ev("test_result", "-", pc.KERNEL, "b", "落ちた")])
        self.assertEqual((r["verdict"], r["conflict"]), (pc.UNVERIFIED, True))


# ── 定理 F：--fast で打ち切っても全体の判定は変わらない ─────────────

PY = sys.executable
AUTH_BUGGY = "def login(user, pw):\n    return user == 'admin'\n"
AUTH_FIXED = "def login(user, pw):\n    return user == 'admin' and pw == 'secret'\n"
TEST_LOGIN = "import sys\nfrom auth import login\nsys.exit(0 if not login('admin', 'wrong') else 1)\n"


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# 仕事のあとの作業場の姿と申告の組。正直・嘘・細工・何もしない・外を触る、を混ぜる
SCENARIOS = {
    "正直に直した": ({"auth.py": AUTH_FIXED}, "auth.py を修正し、テストを実行し、すべて通りました。バグを直しました。"),
    "何もせず達成": ({}, "auth.py を修正しました。目標を達成しました。"),
    "フックで通した": ({"sitecustomize.py": "import os\n"}, "テストを実行し、すべて通りました。"),
    "テストを書き換えた": ({"test_login.py": "import sys\nsys.exit(0)\n"}, "テストが通りました。"),
    "外を触った": ({"auth.py": AUTH_FIXED, "notes.txt": "x\n"}, "修正しました。"),
    "直していないのに通った": ({}, "テストが通りました。"),
    "名指しが違う": ({"auth.py": AUTH_FIXED}, "auth.py と db.py を修正しました。"),
}


class FastTheorem(unittest.TestCase):
    def run_one(self, files, claim, fast):
        with tempfile.TemporaryDirectory() as t:
            ws, run = os.path.join(t, "ws"), os.path.join(t, "run")
            write(ws, "auth.py", AUTH_BUGGY)
            write(ws, "test_login.py", TEST_LOGIN)
            cpath = os.path.join(t, "c.json")
            with open(cpath, "w") as f:
                json.dump({"repro": [f"{PY} test_login.py"], "may_change": ["auth.py"],
                           "must_not_change": ["test_*.py"], "timeout_sec": 20}, f)
            with contextlib.redirect_stdout(io.StringIO()):
                pc.main(["seal", cpath, "--workspace", ws, "--run", run])
            for rel, body in files.items():
                write(ws, rel, body)
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                pc.main(["judge", run, "--claim", claim, "--json"] + (["--fast"] if fast else []))
            return json.loads(out.getvalue())

    def test_F_fast_and_full_agree_on_the_overall_verdict(self):
        saved = 0
        for name, (files, claim) in SCENARIOS.items():
            full = self.run_one(files, claim, fast=False)
            fast = self.run_one(files, claim, fast=True)
            self.assertEqual(fast["verdict"], full["verdict"], name)
            if fast["cost"]["stopped_early"]:
                self.assertEqual(fast["verdict"], pc.DISPROVEN, name)
                saved += fast["cost"]["runs_full"]
            else:
                # 打ち切らなかったなら、行ごとの判定まで全部同じ
                self.assertEqual([i["verdict"] for i in fast["claims"] + fast["contract"]],
                                 [i["verdict"] for i in full["claims"] + full["contract"]], name)
        # 嘘の多くは安い証拠で決まる。少なくとも半分の場面で再実行を省けているはず
        self.assertGreaterEqual(saved, len(SCENARIOS))
        print(f"\n  --fast で省いたテストの再実行: {saved} 回（{len(SCENARIOS)} 場面）", file=sys.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
