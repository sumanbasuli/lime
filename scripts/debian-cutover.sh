#!/usr/bin/env bash
# Stop the old services before reinstalling, then gate the UI restart on backend health.

wait_for_debian_shopkeeper_health() {
  local port="$1"
  local url="http://127.0.0.1:${port}/api/health"
  local attempt

  for ((attempt = 1; attempt <= 30; attempt++)); do
    if systemctl is-active --quiet lime-shopkeeper.service &&
       node -e '
         const http = require("node:http");
         process.exitCode = 1;
         const request = http.get(process.argv[1], { signal: AbortSignal.timeout(2000) }, response => {
           response.resume();
           response.on("end", () => { if (response.statusCode === 200) process.exitCode = 0; });
           response.on("error", () => { process.exitCode = 1; });
         });
         request.on("error", () => { process.exitCode = 1; });
       ' "${url}" >/dev/null 2>&1; then
      echo "    Shopkeeper healthy after ${attempt} attempts"
      return 0
    fi
    if (( attempt < 30 )); then
      sleep 2
    fi
  done

  echo "Shopkeeper did not become healthy after restart; UI was not restarted." >&2
  return 1
}

install_and_restart_debian_services() {
  local installer="$1"
  local port="$2"

  echo "==> Stopping UI and Shopkeeper before reinstalling"
  systemctl stop lime-ui.service || return
  systemctl stop lime-shopkeeper.service || return

  echo "==> Reinstalling"
  "${installer}" || return

  echo "==> Restarting Shopkeeper"
  systemctl restart lime-shopkeeper.service || return
  echo "==> Waiting for Shopkeeper migrations and HTTP health on port ${port}"
  wait_for_debian_shopkeeper_health "${port}" || return

  echo "==> Restarting UI"
  systemctl restart lime-ui.service
}
