import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = await readFile(path.join(repository, "scripts/install.sh"), "utf8");

// Every system/package/network/container command is replaced by a local shim.
// Fixtures are disposable. This suite never contacts a daemon, package manager,
// GitHub, Homebrew, or a real database and never requires root.
async function scenario(name, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lime-install-contract-"));
  const bin = path.join(root, "bin");
  const target = path.join(root, "fresh lime");
  await mkdir(bin);
  const shim = `#!/bin/bash
printf '%s %s\\n' "__SHELL{0##*/}" "$*" >> "$LIME_TEST_ROOT/calls"
case "__SHELL{0##*/}" in
  uname) printf '%s\\n' "$LIME_TEST_OS";;
  id) if [[ "$1" == -u ]]; then printf '1000\\n'; else /usr/bin/id "$@"; fi;;
  xcode-select) [[ "$LIME_TEST_CASE" != xcode ]];;
  open) touch "$LIME_TEST_ROOT/docker-ready"; exit 0;;
  sleep) exit 0;;
  sudo) if [[ "$1" == docker ]]; then LIME_TEST_SUDO=1 "$LIME_TEST_ROOT/bin/docker" "__SHELL{@:2}"; else "$@"; fi;;
  systemctl|apt-get|dnf|yum|install) if [[ "$*" == *'docker-ce-cli'* ]]; then touch "$LIME_TEST_ROOT/docker-installed"; fi; if [[ "$*" == *'git make curl openssl'* ]]; then touch "$LIME_TEST_ROOT/dependencies-installed"; fi; exit 0;;
  dpkg) printf 'amd64\\n';;
  dpkg-query) exit 1;;
  brew) touch "$LIME_TEST_ROOT/docker-installed"; exit 0;;
  sed)
    if [[ "$*" == *'/etc/os-release'* ]]; then
      if [[ "$*" == *'VERSION_CODENAME'* ]]; then printf 'noble\\n'; else printf 'ubuntu\\n'; fi
    else /usr/bin/sed "$@"; fi;;
  openssl) if [[ "$LIME_TEST_CASE" == random-failure ]]; then printf 'bad\\n'; elif [[ "__SHELL{@: -1}" == 4 ]]; then printf '0123abcd\\n'; else printf 'abcdef0123456789abcdef0123456789abcdef0123456789\\n'; fi;;
  git)
    if [[ "$1" == clone ]]; then
      destination="__SHELL{@: -1}"
      mkdir -p "$destination"
      cp "$LIME_TEST_ROOT/template.env" "$destination/.env.example"
      printf 'start-all:\\n\\t@true\\n' > "$destination/Makefile"
      printf 'services: {}\\n' > "$destination/docker-compose.yml"
      printf '2.0.0\\n' > "$destination/VERSION"
      mkdir -p "$destination/data"
      for catalog in act-rules axe-guidance axe-rules axe-act-mapping; do printf '{}\\n' > "$destination/data/$catalog.json"; done
      if [[ "$LIME_TEST_CASE" == catalog-file-symlink || "$LIME_TEST_CASE" == catalog-directory-symlink ]]; then
        mkdir "$LIME_TEST_ROOT/private-catalog"
        printf 'keep private catalog\\n' > "$LIME_TEST_ROOT/private-catalog/sentinel.json"
        chmod 0700 "$LIME_TEST_ROOT/private-catalog"
        chmod 0600 "$LIME_TEST_ROOT/private-catalog/sentinel.json"
        if [[ "$LIME_TEST_CASE" == catalog-file-symlink ]]; then
          rm "$destination/data/act-rules.json"
          ln -s "$LIME_TEST_ROOT/private-catalog/sentinel.json" "$destination/data/act-rules.json"
        else
          rm -r "$destination/data"
          ln -s "$LIME_TEST_ROOT/private-catalog" "$destination/data"
        fi
      fi
    elif [[ "$*" == *'rev-parse --short HEAD'* ]]; then printf 'deadbeef1234\\n'; fi;;
  make)
    [[ "$LIME_TEST_CASE" != build-failure ]] || exit 42;;
  docker)
    if [[ "$1" == --host ]]; then shift 2; fi
    case "$*" in
      info) [[ "$LIME_TEST_CASE" != daemon-failure ]] || exit 1; if [[ "$LIME_TEST_CASE" == desktop-start && ! -f "$LIME_TEST_ROOT/docker-ready" ]]; then exit 1; fi; if [[ "$LIME_TEST_CASE" == sudo-socket && "__SHELL{LIME_TEST_SUDO:-}" != 1 ]]; then exit 1; fi;;
      'compose version --short') [[ "$LIME_TEST_CASE" != missing-compose ]] || exit 1; if [[ "$LIME_TEST_CASE" == old-compose ]]; then printf '2.23.0\\n'; else printf '2.24.4\\n'; fi;;
      'compose version') [[ "$LIME_TEST_CASE" != missing-compose ]] || exit 1;;
      'context inspect'*) if [[ "$LIME_TEST_CASE" == remote-context ]]; then printf 'ssh://remote.example\\n'; else printf 'unix:///controlled-test.sock\\n'; fi;;
      ps*) if [[ "$LIME_TEST_CASE" == existing-container ]]; then printf 'lime-ui\\n'; fi;;
      'volume ls'*) if [[ "$LIME_TEST_CASE" == existing-volume ]]; then printf 'lime_pgdata\\n'; fi;;
      run*) [[ "$LIME_TEST_CASE" != port-failure ]] || exit 42;;
      inspect*) printf 'lime-install-0123abcd\\n';;
    esac;;
  curl)
    destination=''; source=''
    while [[ $# -gt 0 ]]; do
      case "$1" in --output|-o) destination="$2"; shift 2;; http*) source="$1"; shift;; *) shift;; esac
    done
    if [[ "$source" == *'/gpg' ]]; then
      printf '%s\\n' '-----BEGIN PGP PUBLIC KEY BLOCK-----' > "$destination"
      [[ "$LIME_TEST_CASE" != interrupted-key ]] || exit 23
    elif [[ "$source" == *'Homebrew/install'* ]]; then
      printf '#!/bin/bash\\nexit 0\\n' > "$destination"
      [[ "$LIME_TEST_CASE" != interrupted-homebrew ]] || exit 23
    elif [[ "$LIME_TEST_CASE" == readiness-failure ]]; then exit 7
    elif [[ "$source" == *'/logo.svg' ]]; then
      [[ "$LIME_TEST_CASE" != asset-failure ]] || exit 22
      printf '<svg xmlns="http://www.w3.org/2000/svg"></svg>\\n'
    elif [[ "$source" == *'/api/health' ]]; then printf '{"status":"ok"}\\n'
    elif [[ "$source" == *'/api/scans' ]]; then printf '[]\\n'
    else printf '<html><body>LIME</body></html>\\n'; fi;;
esac
`.replaceAll("__SHELL{", "${");
  const commands = ["uname", "id", "xcode-select", "open", "sleep", "sudo", "systemctl", "apt-get", "dnf", "yum", "install", "dpkg", "dpkg-query", "brew", "sed", "openssl", "git", "make", "docker", "curl"];
  for (const command of commands) await writeFile(path.join(bin, command), shim, { mode: 0o700 });
  await writeFile(path.join(root, "template.env"), "POSTGRES_USER=lime\nPOSTGRES_PASSWORD=\nPOSTGRES_DB=lime_db\nDATABASE_URL=\nSHOPKEEPER_URL=http://localhost:8080\nLIME_API_PORT=8080\nLIME_UI_PORT=3000\nLIME_UPDATE_CHECK=true\n");
  // Hide a shim only until a simulated package/cask install completes. This
  // intercepts command lookup, never delegates hidden commands to the host.
  const shellEnvironment = `command() {
  if [[ "$1" == -v ]]; then
    if [[ "$2" == docker && "__SHELL{LIME_TEST_MISSING_DOCKER:-}" == true && ! -f "$LIME_TEST_ROOT/docker-installed" ]]; then return 1; fi
    if [[ "__SHELL{LIME_TEST_MISSING_PREREQUISITES:-}" == true && ! -f "$LIME_TEST_ROOT/dependencies-installed" ]]; then
      case "$2" in git|make|curl|openssl) return 1;; esac
    fi
    if [[ "$2" == brew && "$LIME_TEST_CASE" == interrupted-homebrew ]]; then return 1; fi
  fi
  builtin command "$@"
}
# Keep tests fully isolated even if installer prepends Homebrew CLI directories.
docker() { "$LIME_TEST_ROOT/bin/docker" "$@"; }
brew() { "$LIME_TEST_ROOT/bin/brew" "$@"; }
git() { "$LIME_TEST_ROOT/bin/git" "$@"; }
make() { "$LIME_TEST_ROOT/bin/make" "$@"; }
curl() { "$LIME_TEST_ROOT/bin/curl" "$@"; }
openssl() { "$LIME_TEST_ROOT/bin/openssl" "$@"; }
`.replaceAll("__SHELL{", "${");
  await writeFile(path.join(root, "bash-env"), shellEnvironment);
  if (name === "existing-directory") { await mkdir(target); await writeFile(path.join(target, ".env"), "KEEP_PRIVATE=true\n"); }
  const scriptPath = path.join(root, "installer.sh");
  const selected = options.truncated === "middle" ? installer.slice(0, Math.floor(installer.length / 2))
    : options.truncated ? installer.slice(0, installer.indexOf("# Do not move the invocation")) : installer;
  await writeFile(scriptPath, selected);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, BASH_ENV: path.join(root, "bash-env"),
    LIME_TEST_ROOT: root, LIME_TEST_CASE: name, LIME_TEST_OS: options.os || "Linux",
    LIME_INSTALL_DIR: target, LIME_REF: "v2.0.0", TMPDIR: root,
    LIME_TEST_MISSING_DOCKER: options.missingDocker ? "true" : "false",
    LIME_UI_PORT: "15000", LIME_API_PORT: "18080", LIME_DB_PORT: "17432",
    ...options.env,
  };
  const arguments_ = [scriptPath, ...(options.args || [])];
  const result = spawnSync("/bin/bash", options.umask
    ? ["-c", 'umask "$1"; shift; exec /bin/bash "$@"', "fixture", options.umask, ...arguments_]
    : arguments_, { env, cwd: root, encoding: "utf8", timeout: 15_000 });
  const calls = await readFile(path.join(root, "calls"), "utf8").catch(() => "");
  let configuration;
  try { configuration = await readFile(path.join(target, ".env"), "utf8"); } catch { /* refusal/no clone is expected */ }
  return {
    root, target, result, calls, configuration,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function assertNoInstallActivity(fixture, existingDirectory = false) {
  assert.equal(fixture.calls, "", "Argument handling does not invoke any system/package/network/container shim");
  assert.equal(fixture.configuration, existingDirectory ? "KEEP_PRIVATE=true\n" : undefined);
  assert.deepEqual((await readdir(fixture.root)).sort(), [
    "bash-env", "bin", ...(existingDirectory ? ["fresh lime"] : []), "installer.sh", "template.env",
  ].sort(), "Only test harness files and a pre-existing directory remain; no installation files are created");
}

test("--help and -h explain local installation without installing", async () => {
  for (const argument of ["--help", "-h"]) {
    for (const name of ["help", "existing-directory"]) {
      const fixture = await scenario(name, {
        args: [argument],
        os: "UnsupportedOS",
        missingDocker: true,
        env: { LIME_REF: "--invalid", LIME_UI_PORT: "invalid", LIME_TEST_MISSING_PREREQUISITES: "true" },
      });
      try {
        assert.equal(fixture.result.status, 0, fixture.result.stderr);
        assert.equal(fixture.result.stderr, "");
        assert.match(fixture.result.stdout, /usage:/i);
        assert.match(fixture.result.stdout, /bash -s -- --help/);
        assert.match(fixture.result.stdout, /macOS/i);
        assert.match(fixture.result.stdout, /Linux/i);
        assert.match(fixture.result.stdout, /Docker/i);
        assert.match(fixture.result.stdout, /local/i);
        assert.doesNotMatch(fixture.result.stdout, /LIME is ready|Cloning sumanbasuli/);
        await assertNoInstallActivity(fixture, name === "existing-directory");
      } finally { await fixture.cleanup(); }
    }
  }
});

test("unknown arguments and extra arguments fail before environment, platform or installation checks", async () => {
  for (const args of [["--version"], ["--cloud"], ["install"], ["--"], [""], ["--help", "extra"], ["-h", "--help"], ["--help", "--help"], ["--cloud", "--help"]]) {
    const fixture = await scenario("existing-directory", {
      args,
      os: "UnsupportedOS",
      missingDocker: true,
      env: { LIME_REF: "--invalid", LIME_UI_PORT: "invalid", LIME_TEST_MISSING_PREREQUISITES: "true" },
    });
    try {
      assert.notEqual(fixture.result.status, 0, JSON.stringify(args));
      assert.match(fixture.result.stderr, /argument|option|usage|--help/i);
      assert.doesNotMatch(fixture.result.stderr, /destination already exists|LIME_REF must|must be integers|Unsupported platform/i);
      assert.doesNotMatch(fixture.result.stdout, /LIME is ready|Cloning sumanbasuli/);
      await assertNoInstallActivity(fixture, true);
    } finally { await fixture.cleanup(); }
  }
});

test("Linux and macOS existing Docker install fresh, private-port isolated deployments", async () => {
  for (const os of ["Linux", "Darwin"]) {
    const fixture = await scenario("success", { os });
    try {
      assert.equal(fixture.result.status, 0, fixture.result.stderr);
      assert.match(fixture.calls, /git clone -- https:\/\/github.com\/sumanbasuli\/lime.git/);
      assert.match(fixture.calls, /git -C .* checkout --detach v2.0.0/);
      assert.match(fixture.calls, /make -C .*DOCKER_COMPOSE=.*docker-compose.install.yml.*start-all/);
      assert.match(fixture.configuration, /COMPOSE_FILE=docker-compose.yml:docker-compose.install.yml/);
      assert.match(fixture.configuration, /COMPOSE_PROJECT_NAME=lime-install-0123abcd/);
      assert.match(fixture.configuration, /LIME_VERSION=2\.0\.0/);
      assert.match(fixture.configuration, /LIME_COMMIT=deadbeef1234/);
      assert.match(fixture.configuration, /DATABASE_URL=postgresql:\/\/lime:[a-f0-9]{48}@localhost:17432\/lime_db/);
      assert.equal((await stat(path.join(fixture.target, ".env"))).mode & 0o777, 0o600);
      const ports = await readFile(path.join(fixture.target, "docker-compose.install.yml"), "utf8");
      assert.equal((ports.match(/ports: !override/g) || []).length, 3);
      assert.match(ports, /127\.0\.0\.1:15000:3000/);
      assert.match(ports, /127\.0\.0\.1:18080:8080/);
      assert.match(ports, /127\.0\.0\.1:17432:5432/);
      assert.equal((ports.match(/LIME_VERSION: \$\{LIME_VERSION\}/g) || []).length, 2);
      assert.match(fixture.calls, /curl .*http:\/\/127\.0\.0\.1:15000\/api\/scans/);
      assert.match(fixture.result.stdout, /LIME is ready at http:\/\/localhost:15000/);
      assert.doesNotMatch(fixture.calls, /docker (?:stop|rm|compose down)|usermod|groupadd/);
    } finally { await fixture.cleanup(); }
  }
});

test("a private install umask keeps mounted public catalogs readable without exposing configuration or other code", async () => {
  const fixture = await scenario("success", { umask: "077" });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal((await stat(path.join(fixture.target, "data"))).mode & 0o777, 0o755);
    for (const name of ["act-rules", "axe-guidance", "axe-rules", "axe-act-mapping"]) {
      assert.equal((await stat(path.join(fixture.target, "data", `${name}.json`))).mode & 0o777, 0o644);
    }
    assert.equal((await stat(path.join(fixture.target, ".env"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(fixture.target, "Makefile"))).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.target)).mode & 0o777, 0o700);
  } finally { await fixture.cleanup(); }
});

test("catalog links cannot broaden a private file or directory's permissions", async () => {
  for (const name of ["catalog-file-symlink", "catalog-directory-symlink"]) {
    const fixture = await scenario(name);
    try {
      assert.equal(fixture.result.status, 1);
      assert.match(fixture.result.stderr, /symlink|ordinary JSON/);
      assert.doesNotMatch(fixture.calls, /make -C/);
      assert.equal(fixture.configuration, undefined);
      assert.equal((await stat(path.join(fixture.root, "private-catalog"))).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(fixture.root, "private-catalog/sentinel.json"))).mode & 0o777, 0o600);
      assert.equal(await readFile(path.join(fixture.root, "private-catalog/sentinel.json"), "utf8"), "keep private catalog\n");
    } finally { await fixture.cleanup(); }
  }
});

test("existing directories, stopped containers and orphaned default volumes are never reused", async () => {
  for (const name of ["existing-directory", "existing-container", "existing-volume"]) {
    const fixture = await scenario(name);
    try {
      assert.equal(fixture.result.status, 1);
      assert.doesNotMatch(fixture.calls, /git clone|make -C|docker run/);
      if (name === "existing-directory") assert.equal(fixture.configuration, "KEEP_PRIVATE=true\n");
      assert.doesNotMatch(fixture.calls, /docker (?:stop|rm|volume rm)|compose down/);
    } finally { await fixture.cleanup(); }
  }
});

test("default main source installs retain a branch instead of a detached HEAD", async () => {
  const fixture = await scenario("success", { env: { LIME_REF: "main" } });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.calls, /git -C .* checkout main/);
    assert.doesNotMatch(fixture.calls, /checkout --detach/);
  } finally { await fixture.cleanup(); }
});

test("unsafe Compose, occupied ports and failed builds/readiness never announce success", async () => {
  for (const name of ["old-compose", "port-failure", "build-failure", "readiness-failure", "asset-failure", "random-failure", "daemon-failure", "missing-compose", "remote-context"]) {
    const fixture = await scenario(name);
    try {
      assert.notEqual(fixture.result.status, 0, `${name}: ${fixture.result.stdout}`);
      assert.doesNotMatch(fixture.result.stdout, /LIME is ready/);
      if (["old-compose", "port-failure", "daemon-failure", "missing-compose", "remote-context"].includes(name)) assert.doesNotMatch(fixture.calls, /git clone|make -C/);
    } finally { await fixture.cleanup(); }
  }
});

test("Linux missing Docker uses official apt signed-by repository without removing existing packages", async () => {
  const fixture = await scenario("success", { missingDocker: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.calls, /https:\/\/download.docker.com\/linux\/ubuntu\/gpg/);
    assert.match(fixture.calls, /install -m 0644 .*docker.sources \/etc\/apt\/sources.list.d\/docker.sources/);
    assert.match(fixture.calls, /apt-get install -y --no-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin/);
    assert.doesNotMatch(fixture.calls, /apt-get (?:remove|purge)|get.docker.com/);
  } finally { await fixture.cleanup(); }
});

test("Linux installs missing git, make, curl and openssl before cloning", async () => {
  const fixture = await scenario("success", { env: { LIME_TEST_MISSING_PREREQUISITES: "true" } });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.calls, /apt-get install -y --no-upgrade git make curl openssl/);
    assert.match(fixture.calls, /NEEDRESTART_MODE=l/);
    assert.ok(fixture.calls.indexOf("apt-get install -y --no-upgrade git make curl openssl") >= 0);
    assert.ok(fixture.calls.indexOf("apt-get install -y --no-upgrade git make curl openssl") < fixture.calls.indexOf("git clone"));
  } finally { await fixture.cleanup(); }
});

test("interrupted signing-key and Homebrew downloads are never installed/executed", async () => {
  for (const [name, os] of [["interrupted-key", "Linux"], ["interrupted-homebrew", "Darwin"]]) {
    const fixture = await scenario(name, { os, missingDocker: true });
    try {
      assert.equal(fixture.result.status, 1);
      assert.doesNotMatch(fixture.calls, /install -m 0644|brew install|git clone|make -C/);
      assert.match(fixture.result.stderr, /Download failed|download failed/);
    } finally { await fixture.cleanup(); }
  }
});

test("macOS GUI toolchain and Docker daemon requirements fail with actionable instructions", async () => {
  for (const name of ["xcode", "daemon-failure"]) {
    const fixture = await scenario(name, { os: "Darwin" });
    try {
      assert.equal(fixture.result.status, 1);
      assert.doesNotMatch(fixture.calls, /git clone|make -C/);
      assert.match(fixture.result.stderr, /Command Line Tools|Docker Desktop is not ready/);
      if (name === "daemon-failure") assert.match(fixture.calls, /open -a Docker/);
    } finally { await fixture.cleanup(); }
  }
});

test("macOS installs missing Docker Desktop and waits for its engine", async () => {
  const fixture = await scenario("desktop-start", { os: "Darwin", missingDocker: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.calls, /brew install --cask docker/);
    assert.match(fixture.calls, /open -a Docker/);
    assert.ok(fixture.calls.indexOf("open -a Docker") < fixture.calls.indexOf("git clone"));
  } finally { await fixture.cleanup(); }
});

test("sudo socket wrapper forwards Docker argv without changing group membership", async () => {
  const fixture = await scenario("sudo-socket");
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.calls, /sudo .*docker --host unix:\/\/\/controlled-test.sock compose version/);
    assert.match(fixture.result.stdout, /Docker calls will use sudo/);
    assert.match(fixture.result.stdout, /sudo .*docker --host unix:\/\/\/controlled-test.sock compose -f docker-compose.yml/);
    assert.doesNotMatch(fixture.calls, /systemctl start docker/);
    assert.doesNotMatch(fixture.calls, /usermod|groupadd/);
  } finally { await fixture.cleanup(); }
});

test("DOCKER_CONTEXT takes precedence over DOCKER_HOST when checking local-only Docker", async () => {
  for (const [name, env, expectedStatus] of [
    ["remote-context", { DOCKER_CONTEXT: "remote", DOCKER_HOST: "unix:///local.sock" }, 1],
    ["success", { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://remote.example" }, 0],
    ["success", { DOCKER_HOST: "ssh://remote.example" }, 1],
  ]) {
    const fixture = await scenario(name, { env });
    try {
      assert.equal(fixture.result.status, expectedStatus, fixture.result.stderr);
      if (env.DOCKER_CONTEXT) assert.match(fixture.calls, new RegExp(`docker context inspect .* ${env.DOCKER_CONTEXT}`));
      if (expectedStatus !== 0) assert.doesNotMatch(fixture.calls, /git clone|make -C|docker run/);
    } finally { await fixture.cleanup(); }
  }
});

test("truncated outer curl stream cannot reach any installer side effects", async () => {
  for (const truncated of [true, "middle"]) {
    const fixture = await scenario("truncated", { truncated });
    try {
      assert.equal(fixture.calls, "");
      assert.equal(fixture.configuration, undefined);
      assert.doesNotMatch(fixture.result.stdout, /LIME is ready/);
    } finally { await fixture.cleanup(); }
  }
});

test("invalid refs and ports fail before any system command", async () => {
  for (const env of [{ LIME_REF: "--force" }, { LIME_UI_PORT: "3000; touch bad" }, { LIME_DB_PORT: "99999" }, { LIME_API_PORT: "15000" }]) {
    const fixture = await scenario("invalid-options", { env });
    try {
      assert.equal(fixture.result.status, 1);
      assert.equal(fixture.calls, "");
      assert.equal(fixture.configuration, undefined);
    } finally { await fixture.cleanup(); }
  }
});
