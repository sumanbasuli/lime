#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${LIME_DOCS_COMPOSE_PROJECT:-lime-docs}"
API_PORT="${LIME_DOCS_API_PORT:-18080}"
UI_PORT="${LIME_DOCS_UI_PORT:-13000}"
API_BASE="http://localhost:${API_PORT}"
UI_BASE="http://localhost:${UI_PORT}"
DEFAULT_SCAN_TARGETS="https://heysuman.com,https://www.fake-university.com/,https://overlaysdontwork.com/"
IFS=',' read -r -a SCAN_TARGETS <<< "${LIME_DOCS_SCAN_TARGETS:-${DEFAULT_SCAN_TARGETS}}"
SCREENSHOT_DIR="${ROOT_DIR}/docs-site/public/product-screenshots"
STACK_STARTED=false

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required for the docs refresh pipeline." >&2
    exit 1
  fi
}

validate_port() {
  local port="$1"
  local label="$2"
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || [ "${port}" -lt 1 ] || [ "${port}" -gt 65535 ]; then
    echo "${label} must be an integer between 1 and 65535; received '${port}'." >&2
    exit 1
  fi
}

for required_command in curl node npm docker; do
  require_command "${required_command}"
done
source "${ROOT_DIR}/scripts/docs-db-credential.sh"
if [ "${LIME_DOCS_KEEP_STACK:-false}" = "true" ] && [ -z "${LIME_DOCS_DB_PASSWORD:-}" ]; then
  echo "Set LIME_DOCS_DB_PASSWORD when keeping the docs stack so you can access its database later." >&2
  exit 1
fi
validate_port "${API_PORT}" "LIME_DOCS_API_PORT"
validate_port "${UI_PORT}" "LIME_DOCS_UI_PORT"
if [ "${API_PORT}" = "${UI_PORT}" ]; then
  echo "LIME_DOCS_API_PORT and LIME_DOCS_UI_PORT must be different." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker-compose)
else
  echo "Docker Compose is required. Install the Docker Compose plugin or docker-compose." >&2
  exit 1
fi

compose() {
  "${DOCKER_COMPOSE[@]}" -p "${COMPOSE_PROJECT}" -f "${ROOT_DIR}/docker-compose.docs.yml" "$@"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [ "${STACK_STARTED}" = "true" ]; then
    if [ "${LIME_DOCS_KEEP_STACK:-false}" = "true" ]; then
      echo "Docs stack kept running because LIME_DOCS_KEEP_STACK=true."
    else
      echo "Stopping isolated docs stack..."
      compose down >/dev/null 2>&1 || true
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1"
  local label="$2"
  local max_attempts="${3:-120}"

  for attempt in $(seq 1 "${max_attempts}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "${label} is ready."
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for ${label} at ${url}" >&2
  return 1
}

assert_docs_ui_production() {
  local runtime

  runtime="$(
    compose exec -T ui sh -lc 'printf "cmd="; tr "\0" " " < /proc/1/cmdline; printf "\nNODE_ENV=%s\n" "${NODE_ENV:-}"'
  )"

  if printf '%s\n' "${runtime}" | grep -Eq "npm run dev|next dev"; then
    printf '%s\n' "${runtime}" >&2
    echo "Docs screenshots require the production UI runtime, but the UI is running Next dev mode." >&2
    return 1
  fi

  if ! printf '%s\n' "${runtime}" | grep -q "NODE_ENV=production"; then
    printf '%s\n' "${runtime}" >&2
    echo "Docs screenshots require NODE_ENV=production." >&2
    return 1
  fi

  echo "Docs UI is running the production Next build."
}

json_field() {
  local field="$1"
  node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const value = JSON.parse(data)[process.argv[1]]; if (value === undefined || value === null) process.exit(2); process.stdout.write(String(value)); });" "${field}"
}

create_docs_scan() {
  local target="$1"
  local payload
  local response

  payload="$(
    node -e "process.stdout.write(JSON.stringify({ sitemap_url: process.argv[1], scan_type: 'single', tag: 'docs-demo', viewport_preset: 'desktop' }))" "${target}"
  )"
  response="$(
    curl -fsS -X POST "${API_BASE}/api/scans" \
      -H "Content-Type: application/json" \
      --data "${payload}"
  )"
  printf '%s' "${response}" | json_field id
}

wait_for_scan() {
  local scan_id="$1"
  local target="$2"
  local scan_json
  local status
  local scanned
  local total

  echo "Waiting for docs scan ${scan_id} (${target}) to finish..."
  for attempt in $(seq 1 300); do
    scan_json="$(curl -fsS "${API_BASE}/api/scans/${scan_id}")"
    status="$(printf '%s' "${scan_json}" | json_field status)"
    scanned="$(printf '%s' "${scan_json}" | json_field scanned_urls || true)"
    total="$(printf '%s' "${scan_json}" | json_field total_urls || true)"
    echo "  ${status} ${scanned:-0}/${total:-0}"

    if [ "${status}" = "completed" ] || [ "${status}" = "failed" ] || [ "${status}" = "paused" ]; then
      return 0
    fi
    sleep 3
  done

  echo "Timed out waiting for docs scan ${scan_id} (${target})" >&2
  return 1
}

create_docs_link_check() {
  local target="$1"
  local payload
  payload="$(node -e "process.stdout.write(JSON.stringify({ url: process.argv[1], check_type: 'single', max_pages: 1 }))" "${target}")"
  curl -fsS -X POST "${API_BASE}/api/link-checks" \
    -H "Content-Type: application/json" --data "${payload}" | json_field id
}

wait_for_link_check() {
  local check_id="$1"
  local check_json
  local status
  echo "Waiting for docs link check ${check_id}..."
  # The checker has a ten-minute job budget. Allow time for queue/startup too.
  for attempt in $(seq 1 220); do
    check_json="$(curl -fsS "${API_BASE}/api/link-checks/${check_id}")"
    status="$(printf '%s' "${check_json}" | json_field status)"
    if [ "${status}" = "completed" ]; then
      echo "Docs link check completed; individual outcomes and coverage remain visible."
      return 0
    fi
    if [ "${status}" = "failed" ] || [ "${status}" = "cancelled" ]; then
      printf '%s\n' "${check_json}" >&2
      echo "Docs link check did not produce a completed result." >&2
      return 1
    fi
    sleep 3
  done
  echo "Timed out waiting for docs link check ${check_id}" >&2
  return 1
}

origin_for_target() {
  local target="$1"
  node -e "const target = new URL(process.argv[1]); process.stdout.write(target.origin);" "${target}"
}

seed_partial_retry_demo() {
  local scan_id="$1"
  local target="$2"
  local failed_url

  failed_url="$(origin_for_target "${target}")/__lime-docs-intentional-failed-page"

  echo "Seeding one intentional failed URL for partial retry docs (${failed_url})..."
  compose exec -T db psql -U lime -d lime_docs_db -v ON_ERROR_STOP=1 \
    -v scan_id="${scan_id}" \
    -v failed_url="${failed_url}" <<'SQL'
WITH coverage AS (
  SELECT COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
  FROM urls
  WHERE scan_id = :'scan_id'::uuid
),
inserted_failed_url AS (
  INSERT INTO urls (scan_id, url, status)
  SELECT :'scan_id'::uuid, :'failed_url', 'failed'
  WHERE (SELECT completed_count FROM coverage) > 0
  RETURNING id
),
updated_scan AS (
  UPDATE scans
  SET status = 'completed',
      pause_requested = false,
      total_urls = (
        SELECT COUNT(*)
        FROM urls
        WHERE scan_id = :'scan_id'::uuid
      ),
      scanned_urls = (
        SELECT COUNT(*)
        FROM urls
        WHERE scan_id = :'scan_id'::uuid
          AND status IN ('completed', 'failed')
      ),
      updated_at = NOW()
  WHERE id = :'scan_id'::uuid
    AND EXISTS (SELECT 1 FROM inserted_failed_url)
  RETURNING id
)
DELETE FROM scan_score_summary_cache
WHERE scan_id = :'scan_id'::uuid;

DELETE FROM scan_issue_summary_cache
WHERE scan_id = :'scan_id'::uuid;

DELETE FROM scan_report_data_cache
WHERE scan_id = :'scan_id'::uuid;
SQL
}

scan_issue_score() {
  local scan_id="$1"
  local issues_json

  if ! issues_json="$(curl -fsS "${UI_BASE}/api/scans/${scan_id}/issues/chunks?limit=50" 2>/dev/null)"; then
    echo 0
    return 0
  fi

  ISSUES_JSON="${issues_json}" node <<'NODE'
const data = process.env.ISSUES_JSON || "{}";
  try {
    const payload = JSON.parse(data);
    const counts = payload.counts ?? {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const failedItems = items.filter((item) => item.kind === "failed").length;
    const needsReviewItems = items.filter((item) => item.kind === "needs_review").length;
    const occurrenceCount = items.reduce(
      (total, item) => total + (Number(item.occurrenceCount) || 0),
      0
    );
    const score =
      failedItems * 10000 +
      (Number(counts.activeIssueCount) || 0) * 1000 +
      needsReviewItems * 250 +
      (Number(counts.needsReviewCount) || 0) * 100 +
      occurrenceCount;
    process.stdout.write(String(score));
  } catch {
    process.stdout.write("0");
  }
NODE
}

scan_has_completed_page() {
  local scan_id="$1"
  local scan_json
  local scanned

  scan_json="$(curl -fsS "${API_BASE}/api/scans/${scan_id}")"
  scanned="$(printf '%s' "${scan_json}" | json_field scanned_urls || true)"
  [ "${scanned:-0}" -gt 0 ]
}

echo "Preparing docs-site dependencies..."
lime_docs_without_password npm --prefix "${ROOT_DIR}/docs-site" ci

echo "Linting docs-site before starting the isolated scan stack..."
lime_docs_without_password npm --prefix "${ROOT_DIR}/docs-site" run lint

echo "Checking Playwright Chromium..."
if lime_docs_without_password node -e "const { chromium } = require(process.argv[1]); const fs = require('fs'); process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);" "${ROOT_DIR}/docs-site/node_modules/playwright" >/dev/null 2>&1; then
  echo "Playwright Chromium is already installed."
elif [ "${LIME_DOCS_INSTALL_PLAYWRIGHT:-false}" = "true" ]; then
  lime_docs_without_password npm --prefix "${ROOT_DIR}/docs-site" exec playwright install chromium
else
  echo "Playwright Chromium is missing. Run with LIME_DOCS_INSTALL_PLAYWRIGHT=true if this machine needs a browser install." >&2
  exit 1
fi

# Keep a generated test credential out of dependency installation hooks.
lime_docs_db_credential
echo "Resetting isolated ${COMPOSE_PROJECT} docs stack..."
compose down -v --remove-orphans
STACK_STARTED=true
compose up -d --build

wait_for_url "${API_BASE}/api/health" "Shopkeeper"
wait_for_url "${UI_BASE}/" "LIME UI"
assert_docs_ui_production

declare -a SCAN_IDS=()
declare -a SCAN_LABELS=()

echo "Creating isolated docs-demo scans..."
for target in "${SCAN_TARGETS[@]}"; do
  target="$(printf '%s' "${target}" | xargs)"
  if [ -z "${target}" ]; then
    continue
  fi
  if ! node -e "const target = new URL(process.argv[1]); if (!['http:', 'https:'].includes(target.protocol)) process.exit(1);" "${target}" >/dev/null 2>&1; then
    echo "Skipping invalid docs scan target: ${target}" >&2
    continue
  fi
  echo "Creating docs scan for ${target}..."
  scan_id="$(create_docs_scan "${target}")"
  echo "Created docs scan ${scan_id}."
  wait_for_scan "${scan_id}" "${target}"
  if ! scan_has_completed_page "${scan_id}"; then
    echo "Skipping docs scan ${scan_id}; it did not produce a completed page." >&2
    continue
  fi
  SCAN_IDS+=("${scan_id}")
  SCAN_LABELS+=("${target}")
done

if [ "${#SCAN_IDS[@]}" -eq 0 ]; then
  echo "No docs scans were created. Check LIME_DOCS_SCAN_TARGETS." >&2
  exit 1
fi

CAPTURE_SCAN_ID="${SCAN_IDS[0]}"
CAPTURE_SCAN_LABEL="${SCAN_LABELS[0]}"
PARTIAL_SCAN_ID="${SCAN_IDS[0]}"
PARTIAL_SCAN_LABEL="${SCAN_LABELS[0]}"
BEST_SCORE="-1"

echo "Selecting richest docs scan for issue screenshots..."
for index in "${!SCAN_IDS[@]}"; do
  scan_id="${SCAN_IDS[$index]}"
  score="$(scan_issue_score "${scan_id}")"
  echo "  ${scan_id} (${SCAN_LABELS[$index]}) issue score: ${score}"
  if [ "${score}" -gt "${BEST_SCORE}" ]; then
    BEST_SCORE="${score}"
    CAPTURE_SCAN_ID="${scan_id}"
    CAPTURE_SCAN_LABEL="${SCAN_LABELS[$index]}"
  fi
done

seed_partial_retry_demo "${PARTIAL_SCAN_ID}" "${PARTIAL_SCAN_LABEL}"

echo "Creating isolated link-check demo for ${CAPTURE_SCAN_LABEL}..."
LINK_CHECK_ID="$(create_docs_link_check "${CAPTURE_SCAN_LABEL}")"
wait_for_link_check "${LINK_CHECK_ID}"

mkdir -p "${SCREENSHOT_DIR}"
echo "Capturing docs screenshots from ${UI_BASE} for scan ${CAPTURE_SCAN_ID} (${CAPTURE_SCAN_LABEL})..."
lime_docs_without_password npm --prefix "${ROOT_DIR}/docs-site" run docs:screenshots -- \
  --base-url "${UI_BASE}" \
  --scan-id "${CAPTURE_SCAN_ID}" \
  --partial-scan-id "${PARTIAL_SCAN_ID}" \
  --link-check-id "${LINK_CHECK_ID}" \
  --output "${SCREENSHOT_DIR}"

echo "Building static docs site..."
lime_docs_without_password npm --prefix "${ROOT_DIR}/docs-site" run build

echo "Docs refreshed. Static output: ${ROOT_DIR}/docs-site/out"
