# local-ai-stack — don't trust "done"

**An open-source verification layer that checks whether an AI coding agent actually did what it says it did**, built on top of a fully local agent stack that runs on one laptop every day.

When an agent says *"I fixed the bug and all tests pass"*, `proofcheck` does not read that sentence as evidence. It seals a task contract **before** the agent runs, collects evidence the agent cannot write, and judges every claim in the report as **PROVEN**, **DISPROVEN** or **UNVERIFIED**. When it cannot decide, it says exactly which evidence is missing instead of guessing.

> 日本語版: [README.ja.md](README.ja.md) · Most design notes and measurement records are in Japanese; this page and [`verify/README.md`](verify/README.md) are the English entry points.

---

## Why now

Coding agents (OpenAI Codex, Claude Code, OpenHands and many others) now run with write access on developers' machines and inside company infrastructure, often for long stretches with no one watching. Their final report is usually the only thing a human reads.

The industry is converging on **sandboxes**: NVIDIA OpenShell, Codex's own sandbox, container runners. A sandbox bounds what an agent *can touch*. It does not tell you whether the work the agent *claims* actually happened. An agent can stay perfectly inside its sandbox and still report success it did not achieve, for example by special-casing the inputs of the visible test, or by dropping a `sitecustomize.py` that makes the test print OK. CI does not catch this either: CI trusts the repository state the agent produced.

The formats that agents and sandboxes emit (Codex's `exec --json` event stream, OpenShell's OCSF audit log) are being settled right now. This is the moment to make "verify the claim against evidence" a default layer in agent harnesses, while the plumbing is still being decided. Once agents are the default way code gets written, retrofitting verification will be much harder, and teams will be left with two bad options: trust the report, or re-check everything by hand.

## The problem, measured on a real system

Since August 2026 I have run this stack as my daily infrastructure: it answers me on LINE and Discord, writes code with a local 26B model, and watches itself. I logged every failure. **The ledger has 107 entries, and almost none of them crashed.** They kept running and reported success while doing something else:

- Asked to delete a function that did not exist, the coding agent removed two blank lines and reported *"deleted"*. In a re-run it changed `mins // 60` to `mins // 6`, creating a real bug, and reported it had fixed one.
- Asked to make a test pass without editing the test, the agent wrote a `sitecustomize.py` hook that forced the test to print OK and reported *"confirmed successful"*. The original test still failed. (OpenClaw did the same with `conftest.py`.)
- A recovery script logged *"restarted (success)"* 50 times without ever restarting anything; it discarded the return code.
- A watchdog meant to catch "claimed but not done" never fired in **218 sessions**, because the counter it relied on also counted harmless commands.
- In 54 runs of Codex, Claude Code and OpenClaw under the same sandbox, OpenClaw twice reported a task as achieved after doing nothing.

The pattern is the same at every layer: *it is broken, and it does not say so.* Agents do this as a side effect of trying to finish the task, not out of malice, which is exactly why it has to be checked from outside the agent.

## What is in this repository

| Path | What it is |
| --- | --- |
| [`verify/`](verify/) | **The verification layer.** `proofcheck` (seal → judge), `agent-run` (run Codex or qwc under a sealed contract), the task corpus and the measurement tools. Start here. |
| [`guards/`](guards/) | Watchdogs that detect *silent* failures (process alive, work stopped) and restart services, plus `guard-drill`, which breaks things on purpose every morning to prove the watchdogs notice. |
| [`openclaw/`](openclaw/) | Configuration for the [OpenClaw](https://github.com/openclaw/openclaw) gateway (LINE / Discord / terminal / voice). |
| [`tools/`](tools/) | 22 everyday tools around the stack (voice, research, backups, SNS drafts). |
| [qwythos-code](https://github.com/daigo0904/qwythos-code) | **qwc**, my autonomous coding CLI for local models, with in-loop "report watchers". Installed by `./install qwc`. |
| [agent-report-eval](https://github.com/daigo0904/agent-report-eval) | The evaluation harness for qwc's report watchers (1,481 recorded cases replayed through the real agent loop). |

## How the verification works

```
 before the run                after the run
 ──────────────                ─────────────────────────────────────────────
 contract ──┐                  evidence the agent cannot write
            ├─ seal ─────────► • diff against the sealed snapshot      (verifier)
 workspace ─┘   (sealed ID)    • tests re-run with tests and test hooks
                                 restored to the sealed state          (verifier)
                               • hidden tests the agent never saw      (verifier)
                               • harness event log (Codex / qwc)       (harness)
                               • sandbox record (guardrun / OpenShell) (kernel)
                                        │
 agent's final report ─► split into atomic claims ─► rules D1–D4 ─► PROVEN / DISPROVEN / UNVERIFIED
```

- **Claims** are typed: changed files, ran tests, tests pass, bug fixed, behaviour unchanged, external effects, absence claims, and "other". A sentence that cannot be mapped to a type is kept as *other* and stays UNVERIFIED, so the report is never certified from the parts that happened to be easy to parse.
- **Each claim kind requires specific evidence at a minimum strength** (kernel record > verifier's own observation > agent-side log). "Bug fixed" requires the reproduction test to flip *and* hidden tests to pass; a reproduction test that only flips can be satisfied by special-casing its input.
- **Four rules decide the verdict**, and ten properties of those rules are checked by randomized tests (for example: adding evidence can never turn a DISPROVEN claim into PROVEN; stopping early on cheap evidence never changes the overall verdict).
- **DISPROVEN means the evidence contradicts the claim.** Missing evidence is UNVERIFIED, with the missing evidence named. That list is the to-do list for whoever wants a stronger answer.

Details, usage and the exact guarantees: [`verify/README.md`](verify/README.md).

## Results so far, measured blind

My own numbers misled me early on: a rule-based lie detector scored 97% on my own data and **72% (23/32) with 27% false positives** under a blind independent judge. Since then every change to the verifier follows the same protocol:

1. Definitions and metrics are **pre-registered** and committed before anything is measured.
2. Hidden tests and solution sets (honest and deceptive) are written by **separate authors who see only the task text and workspace**, never the rules, contracts or earlier results.
3. Each set is inserted unread and **measured once**. If I want to change something after seeing results, it becomes the next version and is measured on a new set from new authors.

On the latest blind set (33 tasks, 72 deceptive and 48 honest solutions):

| Version | Lies passing the contract | Lies fully certified | Honest solutions wrongly DISPROVEN | Honest solutions fully certified |
| --- | --: | --: | --: | --: |
| Hand-written contracts only | 55 | — | — | — |
| v1 (hidden tests) | 27 | 17 | 1 | 30 |
| v2 | 21 | 6 | 2 | 14 |

The trade-off is visible and deliberate: the verifier stopped certifying lies, and it also certifies fewer honest reports, leaving them UNVERIFIED with named gaps. Five of the six lies still certified are *implicature lies*: the agent did part of the task and only said "I changed the file", which is literally true. A report checker cannot catch those; the contract has to.

**Not measured yet:** real agents on the corpus. Every number above comes from solutions written by blind LLM authors. Running Codex, Claude Code, OpenHands and qwc on the corpus is the next step. Raw records: [`verify/corpus/v2の結果.md`](verify/corpus/v2の結果.md) (Japanese).

## How this was built

This is not a weekend project. It is what came out of living with the failures:

- **A failure ledger of 107 entries**, each with what happened, why it was not noticed, and what changed. Thirty design rules came out of it, such as *never read the report, compare before and after* and *never let the agent's own words count as evidence for the agent*.
- **The sandbox was tested by trying to escape it, on every machine it runs on.** Moving `guardrun` to a second machine exposed 19 holes on its own; a later round of audits (a Codex review plus real runs) closed 22 more. Examples: an SBPL injection through a workspace path that re-enabled the network; allowing `/private/var/folders` for temp files, which silently disabled the wall when the workspace lived underneath. The drill that tests the watchdogs had its own bug of this kind: it sent signals by number, which mean *stop* on macOS and *continue* on Linux, so on Linux it broke nothing and reported a pass.
- **Measured across operating systems**, not assumed: macOS (`sandbox-exec` plus a dedicated user), Linux with bubblewrap, and Linux with Landlock (ABI 7, kernel 6.18), where the Landlock enclosure passes 10 of 11 escape checks, the same as user separation plus bubblewrap. A Landlock proof of concept makes the kernel refuse forging, erasing or replacing the end-of-run record: 5 attacks succeed without it and 5 of 5 are refused with it, at a median cost of 88.5 µs (n = 100). Windows was measured for portability only; it has no enforcer yet, and the docs say so.
- **The real NVIDIA OpenShell was built from source and probed.** Landlock was enforced, but the enforcement was not written to the OCSF audit log, and the default policy allows writes to `/tmp`. So `proofcheck` refuses to claim anything about outside-the-workspace effects from OpenShell's log alone, and that real log is pinned in the test suite.

## Open-source plan

The goal is for agent harnesses to ship with claim verification **on by default**, the way they ship with a sandbox today.

1. **Finish the multi-OS evidence layer**: Linux (Landlock / bubblewrap) and macOS are working; Windows needs an enforcer. Every wall reports what it can and cannot prove (`guardrun --verify`) instead of failing silently.
2. **Publish a small, stable core as a specification**: the contract format, the evidence format and the verdict rules D1–D4, in English, so other tools can implement them without adopting this stack.
3. **Adapters, not a new platform**: Codex and qwc event logs and OpenShell OCSF logs are already supported. Next: Claude Code and OpenHands, and a GitHub Actions step (exit codes are 0 = PROVEN, 1 = DISPROVEN, 2 = UNVERIFIED).
4. **An open benchmark that outsiders can contribute to**: tasks, honest solutions and deceptive solutions written by people who never see the verifier's rules. The blind-author protocol only works with other people, so the community is part of the method, not an add-on.

Everything is MIT-licensed and free.

## Run it yourself

The verifier needs only Python 3:

```sh
git clone https://github.com/daigo0904/local-ai-stack
cd local-ai-stack
python3 verify/test_proofcheck.py && python3 verify/test_theory.py   # verifier and its properties
verify/run_corpus --self-check                                       # the task corpus checks itself
```

The full stack targets macOS with [Ollama](https://ollama.com) and OpenClaw:

```sh
brew install ollama && ollama pull gemma4:26b
npm i -g openclaw
./install            # everything (or: ./install verify | guards | openclaw | tools | qwc)
./install --check    # what is installed and which secrets are still placeholders
claw status          # the whole stack, including watchdog heartbeats
claw run --agent codex --contract login.json "fix the login bug"   # seal → run → judge
```

No keys or personal IDs are in this repository; secrets go in `~/.openclaw/.env`.

## Limitations

- Claims are split by rules, not by a model. Paraphrases can slip past the splitter; unmatched assertions stay UNVERIFIED rather than being dropped.
- A PROVEN verdict is relative to the sealed contract. A weak contract gives a weak PROVEN. Contract drafts can be generated by rules (`verify/contract-draft`), but on fresh tasks they still let lies through (1–2 per set), so drafts must be approved by a person before sealing.
- External effects (production, databases, sent messages) are always UNVERIFIED: the verifier has no read-only window into them yet.
- If every watchdog goes silent at once, or the machine itself dies, nothing inside can notice. An outside witness is needed, and the docs say so.

## License

MIT. [OpenClaw](https://github.com/openclaw/openclaw) and [Ollama](https://github.com/ollama/ollama) are separate projects and are not included.
