#!/usr/bin/env bash
# Git credential helper that mints a short-lived GitHub App installation token.
#
# Wires GitHub App auth into plain `git push` / `git clone` over HTTPS. Git
# invokes this with "get"; it returns a username + a ~1h installation token as
# the password. No long-lived token sits on disk - only the App private key,
# which cannot push by itself.
#
# Requires: openssl, curl, python3 (all standard on Linux).
#
# Configure (per-box, never commit these values):
#   export GH_APP_ID=<numeric app id>
#   export GH_APP_INSTALLATION_ID=<installation id for the org/repo>
#   export GH_APP_PRIVATE_KEY=/path/to/app-private-key.pem   # chmod 600
# Then point git at this helper:
#   git config --global credential."https://github.com".helper "/abs/path/gh-app-credential-helper.sh"
# And remove any github.com line from ~/.git-credentials so the PAT does not win.
set -euo pipefail

# Git passes the operation as $1: get | store | erase. Only "get" needs work.
[ "${1:-get}" = "get" ] || exit 0

: "${GH_APP_ID:?set GH_APP_ID}"
: "${GH_APP_INSTALLATION_ID:?set GH_APP_INSTALLATION_ID}"
: "${GH_APP_PRIVATE_KEY:?set GH_APP_PRIVATE_KEY (path to .pem)}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

now=$(date +%s)
header='{"alg":"RS256","typ":"JWT"}'
payload="{\"iat\":$((now - 60)),\"exp\":$((now + 540)),\"iss\":\"${GH_APP_ID}\"}"
unsigned="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
sig=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$GH_APP_PRIVATE_KEY" | b64url)
jwt="${unsigned}.${sig}"

token=$(curl -sS -X POST \
  -H "Authorization: Bearer ${jwt}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${GH_APP_INSTALLATION_ID}/access_tokens" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

printf 'username=x-access-token\npassword=%s\n' "$token"
