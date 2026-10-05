# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Using AI coding agents

Using AI coding agents (Claude Code, Codex, Cursor and similar) is encouraged. You're still the author, though:

- **Review every line before you open a PR.** You should be able to explain any change in it.
- **Write the PR description yourself.** Keep it short and personal: what you changed, why, and how you checked it. Please don't paste an agent-generated summary.
- **Test it for real.** Run the app and try the change, not just the test suite.

## Pull requests

- Keep PRs small and focused on one thing.
- Use [conventional commits](https://www.conventionalcommits.org/): `feat(web): …`, `fix(do): …`.
- Make sure `npm test` and `npm run typecheck` pass.
- If you change the shared contracts in `src/shared/api.ts`, extend them additively.

## License of contributions

Splitdummy is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). By submitting a contribution, you confirm that you wrote it, or have the right to submit it. You also grant Michal Tajchert a perpetual, worldwide, irrevocable, royalty-free license to use, modify, sublicense and relicense the contribution, including under commercial terms. You keep the copyright to your work.
