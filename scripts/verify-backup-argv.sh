#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-safety.sh
. "${ROOT_DIR}/scripts/backup-safety.sh"

test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT
mkdir "${test_dir}/untrusted-tmp"
chmod 0777 "${test_dir}/untrusted-tmp"
export TMPDIR="${test_dir}/untrusted-tmp"
backup_file="${test_dir}/backup.sql.gz"
expected_safe_url='postgresql://lime@db.example/lime?sslmode=require'
expected_password='secret-backup-test'
expected_passfile_line='*:*:*:*:secret-backup-test'

pg_dump() {
  [[ "$#" -eq 1 && "$1" == "--dbname=${expected_safe_url}" ]] || {
    echo 'pg_dump did not receive the sanitized connection URI' >&2
    return 1
  }
  [[ -z "${DATABASE_URL:-}" ]] || {
    echo 'pg_dump inherited a database password outside the passfile' >&2
    return 1
  }
  if [[ -z "${expected_password}" ]]; then
    [[ -z "${PGPASSFILE:-}" && -z "${PGPASSWORD:-}" ]] || {
      echo 'passfile-only URI unexpectedly received another credential' >&2
      return 1
    }
    printf 'fixture backup\n'
    return 0
  fi
  [[ "$1" != *"${expected_password}"* && -z "${PGPASSWORD:-}" ]] || {
    echo 'pg_dump inherited a database password outside the passfile' >&2
    return 1
  }
  [[ -f "${PGPASSFILE:-}" ]] || { echo 'pg_dump has no passfile' >&2; return 1; }
  [[ "$(dirname -- "${PGPASSFILE}")" == "$(cd -- "${test_dir}" && pwd -P)" ]] || {
    echo 'pg_dump passfile was not placed in the private backup directory' >&2
    return 1
  }
  local mode
  if [[ "$(uname -s)" == Darwin ]]; then
    mode="$(stat -f %Lp "${PGPASSFILE}")"
  else
    mode="$(stat -c %a "${PGPASSFILE}")"
  fi
  [[ "${mode}" == 600 && "$(<"${PGPASSFILE}")" == "${expected_passfile_line}" ]] || {
    echo 'pg_dump passfile contents or permissions are incorrect' >&2
    return 1
  }
  printf 'fixture backup\n'
}

export DATABASE_URL='postgresql://lime:secret-backup-test@db.example/lime?sslmode=require'
export PGPASSWORD='should-not-override-passfile'
dump_external_database "${DATABASE_URL}" "${backup_file}"
[[ "$(gzip -cd -- "${backup_file}")" == 'fixture backup' ]]
if find "${test_dir}" -name '.lime-pgpass.*' -print -quit | grep -q .; then
  echo 'temporary PostgreSQL password file was not removed' >&2
  exit 1
fi
if dump_external_database "${DATABASE_URL}" "${backup_file}" 2>/dev/null; then
  echo 'backup unexpectedly overwrote an existing file' >&2
  exit 1
fi

expected_safe_url='postgres://lime@db.example/lime?sslmode=require'
expected_password='secret:back\\slash'
expected_passfile_line='*:*:*:*:secret\:back\\slash'
dump_external_database 'postgres://lime@db.example/lime?password=secret%3Aback%5Cslash&sslmode=require' "${test_dir}/query.sql.gz"
[[ "$(gzip -cd -- "${test_dir}/query.sql.gz")" == 'fixture backup' ]]

expected_safe_url='postgresql://lime@db.example/lime?sslmode=require'
expected_password='secret-backup-test'
expected_passfile_line='*:*:*:*:secret-backup-test'
dump_external_database 'postgresql://lime:secret-backup-test@db.example/lime?p%61ssfile=%2Ftmp%2Fstale&sslmode=require' "${test_dir}/uri-passfile.sql.gz"
dump_external_database 'postgresql://lime@db.example/lime?sslmode=require&passfile=%2Ftmp%2Fstale&password=secret-backup-test' "${test_dir}/query-passfile.sql.gz"

unset PGPASSWORD
expected_safe_url='postgresql://lime@db.example/lime?passfile=%2Ftmp%2Fexisting&sslmode=require'
expected_password=''
dump_external_database "${expected_safe_url}" "${test_dir}/passfile-only.sql.gz"
[[ "$(gzip -cd -- "${test_dir}/passfile-only.sql.gz")" == 'fixture backup' ]]

for invalid_url in \
  'postgresql://lime:first@db.example/lime?password=second' \
  'postgresql://lime@db.example/lime?password=first&password=second' \
  'postgresql://lime@db.example/lime?password=first%0Asecond' \
  'postgresql://lime@db.example/lime?password=last%0A' \
  'postgresql://lime:last%0A@db.example/lime' \
  'postgresql://lime@db.example/lime?sslpassword=secret' \
  'postgresql://lime:secret@db.example/lime?service=other'; do
  if dump_external_database "${invalid_url}" "${test_dir}/invalid.sql.gz" 2>/dev/null; then
    echo 'invalid or ambiguous connection URI was accepted' >&2
    exit 1
  fi
done
if PGSERVICE=other dump_external_database 'postgresql://lime:secret@db.example/lime' "${test_dir}/invalid-service.sql.gz" 2>/dev/null; then
  echo 'inherited service was accepted with an explicit URI password' >&2
  exit 1
fi

grep -Fq 'dump_external_database "${DATABASE_URL}" "${BACKUP_FILE}"' "${ROOT_DIR}/scripts/debian-update.sh"
grep -Fq 'dump_external_database "${DATABASE_URL}" "${BACKUP_FILE}"' "${ROOT_DIR}/scripts/docker-update.sh"
printf 'External backup argv verification passed.\n'
