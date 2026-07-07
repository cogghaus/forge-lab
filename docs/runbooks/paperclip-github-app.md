# Paperclip GitHub App (git auth for the autonomous agent)

Replaces the personal PAT for the paperclip instance with a GitHub App:
separate bot identity, short-lived (~1h) installation tokens, per-repo install,
revoke by uninstall. The only durable secret on the paperclip box is the App
private key, which cannot push by itself.

## 1. Create the App (Adam / org owner - web UI)

`https://github.com/organizations/sugar-crash-studios/settings/apps` -> **New GitHub App**

- **Name:** `paperclip-scs` (commits will show as `paperclip-scs[bot]`)
- **Homepage URL:** anything (e.g. the repo URL)
- **Webhook:** uncheck **Active** (no webhook needed)
- **Repository permissions:**
  - Metadata: Read (auto)
  - Contents: **Read and write**
  - Pull requests: **Read and write**
  - (Administration / Workflows: leave No access - see HANDOFF.md notes; admin
    merges stay with Adam, OPS work does not touch `.github/workflows/`)
- **Where can this App be installed:** Only on this account
- Create.

Note the **App ID** (numeric, on the App's settings page).

## 2. Generate the private key

On the App settings page -> **Private keys** -> **Generate a private key**. A
`.pem` downloads. This is the durable secret.

## 3. Install the App on forge-lab

App settings -> **Install App** -> install on `sugar-crash-studios` ->
**Only select repositories** -> `forge-lab` -> Install.

Get the **Installation ID**: open the installation (Settings -> Applications,
or `https://github.com/organizations/sugar-crash-studios/settings/installations`)
and read the number at the end of the URL. Or:
`gh api /orgs/sugar-crash-studios/installations -q '.installations[] | {id,app_slug}'`

## 4. Place the key + config on the paperclip box

```sh
install -m 600 /path/to/downloaded.pem ~/.secrets/paperclip-scs.pem
# in the agent's shell profile (NOT committed):
export GH_APP_ID=<app id>
export GH_APP_INSTALLATION_ID=<installation id>
export GH_APP_PRIVATE_KEY="$HOME/.secrets/paperclip-scs.pem"
```

## 5. Wire git to the helper

```sh
chmod +x scripts/gh-app-credential-helper.sh   # or copy it to ~/bin/
git config --global credential."https://github.com".helper "$HOME/bin/gh-app-credential-helper.sh"
# remove the github.com line from ~/.git-credentials so the old PAT cannot win:
sed -i '/github\.com/d' ~/.git-credentials 2>/dev/null || true
```

## 6. Test

```sh
# Mint a token directly:
GH_APP_ID=$GH_APP_ID GH_APP_INSTALLATION_ID=$GH_APP_INSTALLATION_ID \
  GH_APP_PRIVATE_KEY=$GH_APP_PRIVATE_KEY ~/bin/gh-app-credential-helper.sh get
# Expect: username=x-access-token / password=ghs_...

# Real push test (from a clone):
git push --dry-run
```

## Rotate / revoke

- Rotate key: generate a new private key, swap the `.pem`, delete the old key
  in App settings.
- Revoke all access instantly: uninstall the App from the org (Settings ->
  Applications -> paperclip-scs -> Uninstall). No token to chase.

## Notes

- Installation tokens expire in ~1h; the helper mints a fresh one per git auth,
  so nothing long-lived is cached.
- The App acts as `paperclip-scs[bot]`, not as Adam - commit authorship and
  audit trail are cleanly separated.
- `--admin` PR merges are NOT granted to the App (no Administration perm). Adam
  performs admin-merges, preserving the human gate.
