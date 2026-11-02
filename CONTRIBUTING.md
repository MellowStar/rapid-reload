# Contributing

Issues and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach.

## Develop

Needs Node.js 24 or later, and Docker with Compose v2 for the end-to-end test.

```bash
npm test               # unit tests, a few seconds
npm run test:e2e       # real Docker: builds examples/basic and drives it through every kind of update, a few minutes
npm run check:clean    # no secrets or project-specific strings in the package
```

To try a local change against a real project, run the CLI from your checkout:
`node /path/to/rapid-reload/bin/rapid-reload.mjs start --config /path/to/project/rapid-reload.config.json`.

## Rules

[AGENTS.md](AGENTS.md) lists the properties every change must keep. They apply to people too. In short: no runtime
dependencies, `src/plan.mjs` stays pure and tested, and the token never reaches a log, URL or page.

## Release (maintainers)

1. Update `CHANGELOG.md` and the version in `package.json`, and merge.
2. Tag the merge commit `vX.Y.Z` and push the tag.
3. The `release` workflow runs the tests and stages the release on npm with provenance. It needs npm trusted
   publishing set up for this repo and `release.yml`, with direct publishing left off.
4. Approve the staged release with your 2FA: `npm stage list rapid-reload`, check it with `npm stage view <stage-id>`,
   then `npm stage approve <stage-id>`. Use `npm stage reject <stage-id>` if anything looks wrong.
