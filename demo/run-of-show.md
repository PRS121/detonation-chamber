# Run of show (host side)

The demo is one sentence to the agent — *"Ship the next release of tiny-slugify"* — and then three
approvals. This is the sequence the driver (A) follows, and what each person says.

## Before the judges arrive (T-15 min)

- [ ] `.env` filled: `GH_ORG=PRS121`, `NPM_SCOPE=saurav121`, `NPM_TOKEN`, `GITHUB_TOKEN`, `MCP_SHARED_SECRET`, `AGENT_MODEL`, `PUBLISH_MODE=live`.
- [ ] `npm run mcp` up on `127.0.0.1:8787`; `npm run agent:sync` done.
- [ ] TrueForge running from a folder **outside** this repo; release-ops connector + skill registered.
- [ ] `npm run demo:seed` has laid this round's 4 commits on `tiny-slugify` main (verify with `demo:seed --dry-run` first).
- [ ] color-helper `v1.2.4` exists (the BLOCKED fixture). Baseline `@saurav121/tiny-slugify@1.3.0` is on npm.
- [ ] Warm the Daytona sandbox (run one `bootstrap` so the first `exec` isn't a cold start).

## The run

1. **Prompt:** "Ship the next release of tiny-slugify." — the agent reads commits since `v1.3.0`.
2. **Two changed deps found** → chalk and color-helper detonate in parallel (one subagent each). *(B narrates the sealed room + honeytokens.)*
3. **chalk → SAFE**, with the npm intel card. **color-helper → BLOCKED**: decoy read, exfil blocked, workflow planted. *(C narrates the attack; the agent decodes the obfuscated payload live.)*
4. **Self-heal:** burn the room → candidate `v1.2.3` → SAFE in a fresh room → tests pass with the pin.
5. **Release notes** drafted (Features / Fixes / **Security**). Report card shows the verdicts.
6. **Approval 1 — `commit_release_prep`** *(A clicks approve).* Then `manifest` runs on the new commit.
7. **Approval 2 — `create_release`** *(A clicks approve).*
8. **Approval 3 — `publish_package`** — **hand the mouse to a judge.** Manifest is re-checked; publish is live.
9. **Show the results:** the npm page has the new version; the GitHub release shows the notes.

## Talking points

- "Running tests means `npm install`, and `npm install` runs strangers' code." That is the chalk/debug hijack and Shai-Hulud.
- The verdict is **deterministic** — rules decide SAFE/BLOCKED, not the model. The model may only make it *stricter*.
- **The bytes we tested are the bytes we ship**: the manifest hash from the sealed test is re-checked before publish.

## If it breaks (fallback)

- Sandbox cold/slow → we already warmed it; if a step times out, re-run that one `exec`; verdicts are reproducible.
- Network flaky → play the backup video (D). Demo from the last green milestone tag (`m1`/`m2`/`m3`).
- Publish refuses on manifest mismatch → that is the feature working; show the refusal, then re-run `manifest`.
