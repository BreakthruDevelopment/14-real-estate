#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
#   BASE_URL=https://app14.breakthruventures.ai SMOKE_AGENT_EMAIL=... SMOKE_AGENT_PASSWORD=... ./scripts/smoke.sh
#
# Needs an agent account (an admin grants the role; CI seeds it with `pnpm db:seed`):
#   SMOKE_AGENT_EMAIL / SMOKE_AGENT_PASSWORD       required: the run fails loudly without them
#   SMOKE_AGENT2_EMAIL / SMOKE_AGENT2_PASSWORD     optional: a second agent, for the "another agent gets 404" check
#
# This is the 14.1 and 14.4 flow (roles, drafts, access, photos). Later slices add search and inquiries.
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
# Response headers, lower-cased, one per line (no body).
headers() { curl -s -D - -o /dev/null "$@" | tr -d '\r' | tr 'A-Z' 'a-z'; }
header_of() { grep -m1 "^$1:" | cut -d' ' -f2-; }
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

# --- Photos (14.4): the upload boundary and the /img route ---
PHOTO=test/fixtures/images/exif-gps.jpg   # a real JPEG that carries GPS EXIF
[ -f "$PHOTO" ] || fail "missing fixture $PHOTO (run from the repo root)"
upload_photo() { # <jar> <content-type> <op> <file> -> body, then the status on the last line
  curl -s -w '\n%{http_code}' -b "$1" -H "content-type: $2" -H "x-client-op: $3" -H "origin: $BASE_URL" --data-binary "@$4" "$BASE_URL/api/listings/$id/photos"
}
code=$(status -X POST -b "$JAR_A" -H 'content-type: image/jpeg' -H "x-client-op: $(uuid)" -H "origin: $BASE_URL" --data-binary "@$PHOTO" "$BASE_URL/api/listings/$id/photos")
[ "$code" = "403" ] || fail "a buyer uploading a photo should be 403, got $code"
if [ "$HAVE_AGENT2" = "1" ]; then
  code=$(status -X POST -b "$JAR_AGENT2" -H 'content-type: image/jpeg' -H "x-client-op: $(uuid)" -H "origin: $BASE_URL" --data-binary "@$PHOTO" "$BASE_URL/api/listings/$id/photos")
  [ "$code" = "404" ] || fail "another agent's upload to this listing should be 404, got $code"
fi
code=$(upload_photo "$JAR_AGENT" image/png "$(uuid)" "$PHOTO" | tail -1)
[ "$code" = "415" ] || fail "JPEG bytes declared as PNG should be 415, got $code"
code=$(upload_photo "$JAR_AGENT" image/svg+xml "$(uuid)" "$PHOTO" | tail -1)
[ "$code" = "415" ] || fail "an SVG content type should be 415, got $code"
code=$(head -c 4300000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_AGENT" -H 'content-type: image/jpeg' -H "x-client-op: $(uuid)" -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/listings/$id/photos")
[ "$code" = "413" ] || fail "a body over 4 MB should be 413, got $code"
pass "photo uploads: buyer 403, other agent 404, type mismatch 415, over 4 MB 413"

photo_op="$(uuid)"
up=$(upload_photo "$JAR_AGENT" image/jpeg "$photo_op" "$PHOTO"); up_code=$(echo "$up" | tail -1)
[ "$up_code" = "201" ] || fail "photo upload should be 201, got $up_code: $up"
photo=$(echo "$up" | head -n -1 | json_id); [ -n "$photo" ] || fail "no photo id in $up"
again=$(upload_photo "$JAR_AGENT" image/jpeg "$photo_op" "$PHOTO"); again_code=$(echo "$again" | tail -1)
[ "$again_code" = "200" ] || fail "a replayed photo op should be 200, got $again_code"
[ "$(echo "$again" | head -n -1 | json_id)" = "$photo" ] || fail "a replayed photo op must return the first photo"
n=$(curl -fsS -b "$JAR_AGENT" "$BASE_URL/api/listings/$id/photos" | grep -o '"id":"[^"]*"' | wc -l)
[ "$n" = "1" ] || fail "the retried upload made $n photos"
pass "the agent uploaded a photo; the retry returned the same one"

for v in lg md sm; do
  [ "$(status -b "$JAR_AGENT" "$BASE_URL/img/$photo/$v")" = "200" ] || fail "the agent should see their draft's $v variant"
done
h=$(headers -b "$JAR_AGENT" "$BASE_URL/img/$photo/md")
[ "$(echo "$h" | header_of cache-control)" = "private, no-store" ] || fail "a draft photo should be private, no-store: $h"
[ "$(echo "$h" | header_of content-type)" = "image/webp" ] || fail "a photo should be image/webp: $h"
[ "$(echo "$h" | header_of x-content-type-options)" = "nosniff" ] || fail "a photo should carry nosniff: $h"
curl -s -b "$JAR_AGENT" "$BASE_URL/img/$photo/lg" | grep -aq -e 'Exif' -e 'GPS' && fail "the stored photo still carries EXIF/GPS"
[ "$(status "$BASE_URL/img/$photo/md")" = "404" ] || fail "a draft's photo should be 404 anonymously"
[ "$(status -H 'if-none-match: *' "$BASE_URL/img/$photo/md")" = "404" ] || fail "a draft's photo should be 404 anonymously with If-None-Match"
[ "$(status -b "$JAR_A" "$BASE_URL/img/$photo/md")" = "404" ] || fail "a draft's photo should be 404 for a buyer"
[ "$(status "$BASE_URL/img/not-a-uuid/md")" = "404" ] || fail "a malformed photo id should be 404"
pass "the draft's photo is the agent's alone, private and EXIF-free"

# Publish needs a photo, a description of 200+ characters and a location. Typed coordinates work whether or not the
# ZIP centroid table is loaded (that is a later slice); `confirmFar` covers the no-centroid case.
code=$(status -X POST -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"source":"manual","version":2,"lat":30.24235,"lng":-97.76899,"confirmFar":true}' "$BASE_URL/api/agent/listings/$id/location")
[ "$code" = "200" ] || fail "setting the location should be 200, got $code"
desc=$(printf 'A%.0s' $(seq 1 220))
code=$(status -X PATCH -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"version\":3,\"description\":\"$desc\",\"status\":\"active\"}" "$BASE_URL/api/agent/listings/$id")
[ "$code" = "200" ] || fail "publishing with a photo and a description should be 200, got $code"
h=$(headers "$BASE_URL/img/$photo/md")
[ "$(echo "$h" | header_of cache-control)" = "public, max-age=31536000, immutable" ] || fail "a public photo should be immutable: $h"
etag=$(echo "$h" | header_of etag); [ -n "$etag" ] || fail "a public photo should have an ETag"
[ "$(status -H "if-none-match: $etag" "$BASE_URL/img/$photo/md")" = "304" ] || fail "a matching If-None-Match should be 304"
pass "the public photo is immutable and answers its ETag with 304"

# Withdrawing stops the URL answering, on the 200 and the 304 path.
code=$(status -X PATCH -b "$JAR_AGENT" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":4,"status":"withdrawn"}' "$BASE_URL/api/agent/listings/$id")
[ "$code" = "200" ] || fail "withdrawing should be 200, got $code"
[ "$(status "$BASE_URL/img/$photo/md")" = "404" ] || fail "a withdrawn listing's photo should be 404"
[ "$(status -H "if-none-match: $etag" "$BASE_URL/img/$photo/md")" = "404" ] || fail "a withdrawn listing's photo should be 404 on the 304 path too"
pass "a withdrawn listing's photo is 404 on both paths"

# --- Cleanup: only drafts and withdrawn listings can be deleted ---
code=$(status -X DELETE -b "$JAR_AGENT" -H "origin: $BASE_URL" "$BASE_URL/api/agent/listings/$id")
[ "$code" = "204" ] || fail "deleting the withdrawn listing should be 204, got $code"
LISTING_IDS=()
[ "$(status -b "$JAR_AGENT" "$BASE_URL/api/agent/listings/$id")" = "404" ] || fail "a deleted listing should be 404"
[ "$(status -b "$JAR_AGENT" "$BASE_URL/img/$photo/md")" = "404" ] || fail "a deleted listing's photo should be 404"
pass "the agent deleted the listing and its photo"

echo "SMOKE PASS"
