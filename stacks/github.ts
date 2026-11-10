// One-shot stack: mints the scoped Cloudflare token CI deploys with and writes it, with the
// account id, to GitHub Actions secrets. Run it by hand with an admin profile, not from CI:
//
//   alchemy profile create admin
//   alchemy profile edit --profile admin --add Cloudflare   # pick "API Token or API Key"
//   alchemy deploy --config stacks/github.ts --profile admin
//
// The admin credential (Global API Key, or a token with User > API Tokens > Write and
// Account > API Tokens > Write) is root: use it only here. OAuth cannot manage API tokens.
// See https://alchemy.run/cloudflare/tutorial/part-5/
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const owner = "joel611";
const repository = "project-os";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    // Same remote state as the main stack, so the minted token survives this machine.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Resolved from the profile in use, so no CLOUDFLARE_ACCOUNT_ID env var is needed.
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    // Least privilege for `alchemy deploy` of alchemy.run.ts: Workers, D1, KV, R2, Containers.
    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            // `Cloudflare.state()` keeps its auth token in the account's Secrets Store and reads
            // it on every deploy, so CI cannot even open state without this.
            "Secrets Store Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "Workers Containers Write",
            "D1 Write",
            "Account Settings Write",
            "Workers Tail Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        // Custom domains (`ROOT_DOMAIN`): zone-scoped groups, so they nest under the account.
        {
          effect: "allow",
          permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              "com.cloudflare.api.account.zone.*": "*",
            },
          },
        },
      ],
    });

    yield* GitHub.Secret("cf-api-token", {
      owner,
      repository,
      environment: "uat",
      name: "CLOUDFLARE_API_TOKEN",
      value: apiToken.value,
    });

    yield* GitHub.Secret("cf-account-id", {
      owner,
      repository,
      environment: "uat",
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });
  }),
);
