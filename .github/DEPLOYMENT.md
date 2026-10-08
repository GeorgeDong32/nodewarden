# Beta deployment

Hermes monitors upstream changes. After review, merge updates into
`fix/vault-security` and push that branch to `GeorgeDong32/nodewarden`.
The `Verify and deploy vault beta` workflow tests and builds that commit, then
deploys it to `https://vault-beta.georgedong.tech`. Pull requests targeting this
branch run verification only. Hermes does not merge or deploy.

## One-time setup

In the fork's **Settings → Secrets and variables → Actions**, configure:

| Name | Storage | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | A Cloudflare API token permitted to deploy this Worker and its configured resources. Start with the Edit Cloudflare Workers template and scope it to the deployment account and `georgedong.tech` zone. |
| `CLOUDFLARE_ACCOUNT_ID` | Variable (a Secret also works) | The account containing `nodewarden-vault-beta`. |

Do not copy `.dev.vars` or `JWT_SECRET` into GitHub. `deploy:ci` uses `--keep-vars`
to preserve the existing Worker variables and secret bindings, including its
current signing secret. It uses the existing D1 database and R2 bucket in
`wrangler.beta.toml`. The local `npm run deploy:beta` command still works.

Enable GitHub Actions in the fork if needed. The first push containing this
workflow starts a run; if credentials are missing, deployment fails with an
explicit message. After setting them, re-run the failed jobs for the latest
commit from the Actions page. GitHub only exposes the optional manual dispatch
button when this workflow also exists on the repository's default branch.

## Verification and updates

`npm run verify:ci` runs the existing test suite, including the native workerd
backup regression, backend/frontend type checks, translation validation, and
a Wrangler dry run that builds the frontend and bundles the Worker.
Verification needs no Cloudflare credentials. Deployment runs only after it
succeeds, and only for the target branch in this fork.

The workflow serializes runs on the deployment branch and skips deployment if
the tested commit is no longer its tip. Deployment credentials are passed only
to the deploy step. A failed verification prevents deployment. The separate
upstream security scanning workflows are not deployment prerequisites.

When merging upstream, review binding and Durable Object migration changes in
`wrangler.toml` and apply the relevant changes to `wrangler.beta.toml` and the
local `wrangler.my.toml`. NodeWarden initializes/migrates D1 at runtime; do not
reset or replace the database to deploy an update. Review schema changes before
pushing to the deployment branch. A failed deployment after uploading or
migrating resources is not an automatic rollback.

Reference: [Cloudflare's GitHub Actions deployment guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
