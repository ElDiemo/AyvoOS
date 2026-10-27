#!/usr/bin/env bash
# AYVO OS — DEV ONLY: create the test certificates of the bank simulation (doc 036 §10a).
#
#   scripts/dev-rb-simulation-certs.sh [--secrets-dir DIR] [--owner-uid UID]
#
# Creates, with nothing from the real bank, a throw-away CA ("AYVO DEV bank SIMULATION — not a
# bank"), the simulation's server certificate for `rb-simulation`, a client certificate (P12 with a
# random passphrase) and a random client ID, then writes exactly:
#   DIR/rb-premium/     certificate.p12 client-id p12-passphrase simulation-ca.crt  (for Finance)
#   DIR/rb-simulation/  server.key server.crt ca.crt client-id                      (for the simulation)
# each directory 500 and each file 400, owned by UID (default 1000 = the Finance process). The CA's
# private key is discarded, so nothing else can ever be issued under it. Never prints a secret.
#
# Refuses on a production host (prod.env in DIR) and when either directory already exists — it
# never replaces or deletes anything; remove an old set by hand first if that is intended.

set -Eeuo pipefail
umask 077

SECRETS_DIR=/opt/ayvo/secrets
OWNER_UID=1000

die() {
  printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2
  exit 1
}
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }

while (($#)); do
  case $1 in
    --secrets-dir)
      SECRETS_DIR=${2:?--secrets-dir needs a directory}
      shift
      ;;
    --owner-uid)
      OWNER_UID=${2:?--owner-uid needs a number}
      [[ $OWNER_UID =~ ^[0-9]+$ ]] || die "--owner-uid needs a number"
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

command -v openssl >/dev/null || die "openssl is not installed"
[[ -d $SECRETS_DIR ]] || die "$SECRETS_DIR does not exist"
[[ ! -e $SECRETS_DIR/prod.env ]] || die "$SECRETS_DIR holds prod.env: this is a production host — the simulation never exists there"
readonly CLIENT_DIR=$SECRETS_DIR/rb-premium SIM_DIR=$SECRETS_DIR/rb-simulation
for d in "$CLIENT_DIR" "$SIM_DIR"; do
  [[ ! -e $d && ! -L $d ]] || die "$d already exists: nothing is replaced (remove it by hand first if intended)"
done
if [[ $(id -u) != "$OWNER_UID" && $(id -u) != 0 ]]; then
  die "the files must belong to uid $OWNER_UID: run as that user or with sudo"
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
ssl() { openssl "$@" >/dev/null 2>&1 || die "openssl $1 failed"; }

ssl req -x509 -newkey rsa:3072 -nodes -keyout "$work/ca.key" -out "$work/ca.crt" -days 825 \
  -subj '/O=AYVO DEV/CN=AYVO DEV bank SIMULATION CA - not a bank' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign'
leaf() { # name subject extensions
  ssl req -newkey rsa:3072 -nodes -keyout "$work/$1.key" -out "$work/$1.csr" -subj "$2"
  printf '%s\n' "$3" >"$work/$1.ext"
  ssl x509 -req -in "$work/$1.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
    -out "$work/$1.crt" -days 825 -extfile "$work/$1.ext"
}
leaf server '/O=AYVO DEV/CN=rb-simulation' \
  $'subjectAltName=DNS:rb-simulation\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE'
leaf client '/O=AYVO DEV/CN=AYVO DEV Finance (simulation client)' \
  $'extendedKeyUsage=clientAuth\nbasicConstraints=critical,CA:FALSE'
rm -f -- "$work/ca.key" # nothing else is ever issued under this CA

openssl rand -hex 24 | tr -d '\n' >"$work/p12-passphrase"
printf 'dev-simulation-%s' "$(openssl rand -hex 16)" >"$work/client-id"
ssl pkcs12 -export -inkey "$work/client.key" -in "$work/client.crt" -out "$work/certificate.p12" \
  -passout "file:$work/p12-passphrase"

place() { # directory "source:target ..."
  mkdir -m 700 "$1"
  local pair
  for pair in $2; do
    install -m 400 "$work/${pair%%:*}" "$1/${pair##*:}"
  done
  chmod 500 "$1"
  if [[ $(id -u) == 0 ]]; then chown -R "$OWNER_UID:$OWNER_UID" "$1"; fi
}
place "$CLIENT_DIR" "certificate.p12:certificate.p12 client-id:client-id p12-passphrase:p12-passphrase ca.crt:simulation-ca.crt"
place "$SIM_DIR" "server.key:server.key server.crt:server.crt ca.crt:ca.crt client-id:client-id"
ok "bank simulation certificates in $CLIENT_DIR and $SIM_DIR (owner uid $OWNER_UID; CA key discarded; nothing printed)"
