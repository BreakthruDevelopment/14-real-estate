#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
#   BASE_URL=https://app14.breakthruventures.ai SMOKE_AGENT_EMAIL=... SMOKE_AGENT_PASSWORD=... ./scripts/smoke.sh
#
# Needs an agent account (an admin grants the role; CI seeds it with `pnpm db:seed`):
#   SMOKE_AGENT_EMAIL / SMOKE_AGENT_PASSWORD       required: the run fails loudly without them
#   SMOKE_AGENT2_EMAIL / SMOKE_AGENT2_PASSWORD     optional: a second agent, for the "another agent gets 404" check
#
# This is the 14.1 flow (roles, drafts, access). Later slices add photos, publishing, search and inquiries.
# The run deletes the draft it creates, also after a failure.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_AGENT="$(mktemp)"; JAR_AGENT2="$(mktemp)"
LISTING_IDS=()

cleanup() {
  for id in "${LISTING_IDS[@]:-}"; do
    [ -n "$id" ] && curl -s -o /dev/null -X DELETE -b "$JAR_AGENT" -H "origin: $BASE_URL" "$BASE_URL/api/agent/listings/$id" || true
  done
  rm -f "$JAR_A" "$JAR_B" "$JAR_AGENT" "$JAR_AGENT2"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json_id() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
json_version() { grep -o '"version":[0-9]*' | head -1 | cut -d: -f2; }
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }

[ -n "${SMOKE_AGENT_EMAIL:-}" ] && [ -n "${SMOKE_AGENT_PASSWORD:-}" ] || fail "SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD are required (an admin grants the agent role; CI seeds one)"

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(status "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

# Better Auth allows 3 sign-in/sign-up requests per 10 s per IP. Back-to-back runs (smoke right after seeding, or
# several users in a row) can hit it. On a 429, wait out the window and retry once.
post_auth() {
  local jar=$1 path=$2 payload=$3 code
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "$payload" "$BASE_URL$path")
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      echo "auth rate limit (429) on $path; waiting 11s and retrying once"
      sleep 11
      continue
    fi
    break
  done
  case "$code" in 2??) return 0 ;; *) echo "auth request to $path returned $code" >&2; return 1 ;; esac
}

signup() {
  local jar=$1 email=$2
  post_auth "$jar" /api/auth/sign-up/email "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" || fail "sign-up failed for $email"
}

signin() {
  local jar=$1 email=$2 password=$3
  post_auth "$jar" /api/auth/sign-in/email "{\"email\":\"$email\",\"password\":\"$password\"}" || fail "sign-in failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
signin "$JAR_AGENT" "$SMOKE_AGENT_EMAIL" "$SMOKE_AGENT_PASSWORD"
HAVE_AGENT2=0
if [ -n "${SMOKE_AGENT2_EMAIL:-}" ] && [ -n "${SMOKE_AGENT2_PASSWORD:-}" ]; then
  signin "$JAR_AGENT2" "$SMOKE_AGENT2_EMAIL" "$SMOKE_AGENT2_PASSWORD"; HAVE_AGENT2=1
fi
pass "two buyers signed up, agent signed in"

# --- Roles: every sign-up is a buyer; agent-only and admin-only routes say so ---
[ "$(status "$BASE_URL/api/agent/listings")" = "401" ] || fail "anonymous agent list should be 401"
[ "$(status -b "$JAR_A" "$BASE_URL/api/agent/listings")" = "403" ] || fail "buyer on /api/agent/listings should be 403"
[ "$(status -b "$JAR_A" "$BASE_URL/api/admin/stats")" = "403" ] || fail "buyer on /api/admin/stats should be 403"
[ "$(status -b "$JAR_AGENT" "$BASE_URL/api/admin/stats")" = "403" ] || fail "agent on /api/admin/stats should be 403"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"userId":"x","role":"agent"}' "$BASE_URL/api/admin/roles")
[ "$code" = "403" ] || fail "buyer granting a role should be 403, got $code"
[ "$(status -b "$JAR_AGENT" "$BASE_URL/api/agent/listings")" = "200" ] || fail "agent list should be 200"
pass "buyer and agent are refused where they should be"

# Better Auth's own admin user-write endpoints are disabled: signed-in buyers can't reach them either.
for path in set-role create-user update-user remove-user; do
  code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"userId":"x","role":"admin"}' "$BASE_URL/api/auth/admin/$path")
  case "$code" in 403|404) ;; *) fail "/admin/$path should be 403 or 404, got $code" ;; esac
done
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"role":"agent"}' "$BASE_URL/api/auth/update-user")
case "$code" in 2??) fail "a buyer set their own role through /update-user ($code)" ;; esac
pass "role escalation paths refused"

# --- Write hygiene ---
op="$(uuid)"
body="{\"title\":\"Smoke bungalow $RUN_ID\",\"propertyType\":\"house\",\"priceUsd\":425000,\"beds\":3,\"baths\":2,\"addressLine\":\"1 Smoke St\",\"city\":\"Austin\",\"state\":\"TX\",\"zip\":\"78704\",\"clientOpId\":\"$op\"}"
post_listing() { curl -s -w '\n%{http_code}' -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: ${2:-$BASE_URL}" -d "$1" "$BASE_URL/api/agent/listings"; }

code=$(status -b "$JAR_AGENT" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$body" "$BASE_URL/api/agent/listings")
[ "$code" = "403" ] || fail "cross-origin create should be 403, got $code"
code=$(status -b "$JAR_AGENT" -H 'content-type: application/json' -d "$body" "$BASE_URL/api/agent/listings")
[ "$code" = "403" ] || fail "create without an Origin should be 403, got $code"
code=$(status -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/agent/listings")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/agent/listings")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
code=$(status -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "${body/Smoke bungalow/nul\\u0000byte}" "$BASE_URL/api/agent/listings")
[ "$code" = "400" ] || fail "a NUL byte in a title should be 400, got $code"
pass "cross-origin, malformed, oversized and NUL writes refused"

# --- A draft, created once even when the request is retried ---
first=$(post_listing "$body"); first_code=$(echo "$first" | tail -1); first_body=$(echo "$first" | head -n -1)
[ "$first_code" = "201" ] || fail "create should be 201, got $first_code: $first_body"
id=$(echo "$first_body" | json_id); [ -n "$id" ] || fail "no listing id in $first_body"
LISTING_IDS+=("$id")
second=$(post_listing "$body"); second_code=$(echo "$second" | tail -1)
[ "$second_code" = "200" ] || fail "a replayed op id should be 200, got $second_code"
[ "$(echo "$second" | head -n -1 | json_id)" = "$id" ] || fail "a replayed op id must return the first listing"
count=$(curl -fsS -b "$JAR_AGENT" "$BASE_URL/api/agent/listings" | grep -o "\"id\":\"$id\"" | wc -l)
[ "$count" = "1" ] || fail "the retried create made $count listings"
pass "agent created a draft; the retry returned the same one"

# --- Access: a draft is the agent's alone ---
[ "$(status "$BASE_URL/api/listings/$id")" = "404" ] || fail "anonymous read of a draft should be 404"
[ "$(status -b "$JAR_A" "$BASE_URL/api/listings/$id")" = "404" ] || fail "buyer read of a draft should be 404"
[ "$(status -b "$JAR_AGENT" "$BASE_URL/api/listings/$id")" = "200" ] || fail "agent read of own draft should be 200"
[ "$(status "$BASE_URL/api/listings/not-a-uuid")" = "404" ] || fail "a malformed id should be 404"
curl -fsS "$BASE_URL/api/listings/$id" >/dev/null 2>&1 && fail "the draft was readable anonymously"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"listingId\":\"$id\"}" "$BASE_URL/api/favorites")
[ "$code" = "404" ] || fail "favoriting a draft should be 404, got $code"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"listingId\":\"$id\",\"message\":\"hi\",\"clientOpId\":\"$(uuid)\"}" "$BASE_URL/api/inquiries")
[ "$code" = "404" ] || fail "an inquiry on a draft should be 404, got $code"
if [ "$HAVE_AGENT2" = "1" ]; then
  code=$(status -X PATCH -b "$JAR_AGENT2" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"title":"stolen"}' "$BASE_URL/api/agent/listings/$id")
  [ "$code" = "404" ] || fail "a second agent's PATCH should be 404, got $code"
  [ "$(status -b "$JAR_AGENT2" "$BASE_URL/api/agent/listings/$id")" = "404" ] || fail "a second agent's read should be 404"
  pass "a second agent gets 404 on the first agent's draft"
else
  echo "skip - no SMOKE_AGENT2_*: second-agent check not run"
fi
pass "the draft is private to its agent"

# --- Versioned edits and the publish check ---
patched=$(curl -fsS -X PATCH -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"priceUsd":430000}' "$BASE_URL/api/agent/listings/$id") || fail "PATCH failed"
[ "$(echo "$patched" | json_version)" = "2" ] || fail "version should be 2 after the edit: $patched"
code=$(status -X PATCH -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"priceUsd":440000}' "$BASE_URL/api/agent/listings/$id")
[ "$code" = "409" ] || fail "a stale version should be 409, got $code"
code=$(status -X PATCH -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":2,"status":"active"}' "$BASE_URL/api/agent/listings/$id")
[ "$code" = "422" ] || fail "publishing without a photo should be 422, got $code"
pass "stale version is 409; publishing without a photo is refused"

# --- ZIP centroids (14.3) ---
zip_json=$(curl -fsS "$BASE_URL/api/geo/zip/78704") || fail "GET /api/geo/zip/78704 failed (centroids not loaded?)"
echo "$zip_json" | grep -q '"zip":"78704"' || fail "unexpected ZIP answer: $zip_json"
echo "$zip_json" | grep -Eq '"lat":30\.2[0-9]*' || fail "78704 should be near latitude 30.24: $zip_json"
[ "$(status "$BASE_URL/api/geo/zip/00000")" = "404" ] || fail "an unknown ZIP should be 404"
[ "$(status "$BASE_URL/api/geo/zip/abcde")" = "404" ] || fail "a malformed ZIP should be 404"
pass "ZIP centroid lookup"

# --- Cleanup: only drafts and withdrawn listings can be deleted ---
code=$(status -X DELETE -b "$JAR_AGENT" -H "origin: $BASE_URL" "$BASE_URL/api/agent/listings/$id")
[ "$code" = "204" ] || fail "deleting the draft should be 204, got $code"
LISTING_IDS=()
[ "$(status -b "$JAR_AGENT" "$BASE_URL/api/agent/listings/$id")" = "404" ] || fail "a deleted draft should be 404"
pass "the agent deleted the draft"

echo "SMOKE PASS"
