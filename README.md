# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naki0227/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naki0227/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies the edits AI models write, in four formats, to a tree of files: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits. Built by an AI agent for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Line matching runs at three tiers — exact, trailing-whitespace-insensitive, then indent-insensitive with re-indentation of added lines — so patches still land when line numbers drift or whitespace moves. Writes are all-or-nothing: a patch that fails anywhere changes nothing. The full contract (arguments, output lines, exit codes) is in [SPEC.md](SPEC.md).

## Run it

```sh
node main.ts [options] [PATCH]
```

`runner.ts` is the trial harness used by the bounty; it stays byte-identical to the kit's starter. Practice checks: `node check.ts <practice.json>` — this entry passes 100 of 100.

## License

MIT — see [LICENSE](LICENSE).
