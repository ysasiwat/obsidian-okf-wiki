# Check bundles in CI

Use this when an OKF bundle lives in a git repository and you want every pull request checked for
lint errors and out-of-date indexes. The example uses GitHub Actions.

## Before you start

- The bundle is a folder in the repository, for example `Knowledge`.

## Steps

1. Create `.github/workflows/okf.yml` in the bundle's repository:

   ```yaml
   name: OKF bundle
   on: [push, pull_request]
   jobs:
     lint:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/checkout@v4
           with:
             repository: ysasiwat/obsidian-okf-wiki
             path: .okf-wiki
         - uses: actions/setup-node@v4
           with:
             node-version: 22
         - run: npm ci && npm run build:cli
           working-directory: .okf-wiki
         - run: node .okf-wiki/dist/okf.cjs lint Knowledge --strict
         - run: node .okf-wiki/dist/okf.cjs index Knowledge --check
   ```

2. Replace `Knowledge` with the path of your bundle.
3. Optional: drop `--strict` to fail only on errors, not on warnings.
4. Optional: pin the tool to a release by adding `ref: <version tag>` under `with:` of the second
   checkout.
5. Commit and push the workflow.
6. Check that it worked: the workflow run shows the lint summary, for example
   `0 error(s), 0 warning(s), 2 info`, and `indexes are up to date`.

`okf` exits with 1 when the check fails, which fails the job. Run `okf index <bundle> --write`
locally to fix out-of-date indexes.

## See also

- [Command line reference](../reference/cli.md)
- [Lint codes](../reference/lint-codes.md)
- [Check a bundle before you commit it](../examples/01-check-a-bundle-before-you-commit.md)
