# AYVO OS — the files of Finance's bank connection (doc 041, doc 036 §10a), checked the same way
# by the PRODUCTION deployment (scripts/deploy-prod.sh, the bank) and the DEV Finance deployment
# (scripts/deploy-finance-dev.sh, the bank simulation). Sourced; uses the caller's die / ok.
#
# Only kind, owner and mode are checked — the contents are never read or printed.

# The connection's files: the same three everywhere; the simulation adds its own CA (the bank is
# verified by the system's trusted CAs, so production never has one).
readonly RB_PREMIUM_FILES="certificate.p12 client-id p12-passphrase"
readonly RB_PREMIUM_SIMULATION_FILES="certificate.p12 client-id p12-passphrase simulation-ca.crt"

# The accounts read: number:CUR[,number:CUR...] (national number without prefix or bank code).
rb_premium_accounts_valid() {
  [[ $1 =~ ^[0-9]{1,10}:[A-Z]{3}(,[0-9]{1,10}:[A-Z]{3}){0,9}$ ]]
}

# rb_premium_check_dir DIR UID "FILES": DIR is a real directory of UID with mode 500/700 holding
# exactly FILES, each a non-empty regular file of UID with mode 400/600.
rb_premium_check_dir() {
  local dir=$1 uid=$2 want=$3 f mode entries
  [[ -d $dir && ! -L $dir ]] || die "$dir does not exist: the owner stores the bank files there first (doc 036 §10a)"
  [[ $(stat -c '%u' "$dir") == "$uid" ]] || die "$dir must belong to uid $uid (the Finance process)"
  mode="$(stat -c '%a' "$dir")"
  [[ $mode =~ ^[57]00$ ]] || die "$dir must be accessible to its owner only (mode $mode, expected 500)"
  entries="$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')" ||
    die "cannot list $dir (run with sudo)"
  [[ $entries == "$want " ]] ||
    die "$dir must hold exactly $want (found: ${entries:-nothing})"
  for f in $want; do
    [[ -f $dir/$f && ! -L $dir/$f ]] || die "$dir/$f must be a regular file"
    [[ -s $dir/$f ]] || die "$dir/$f is empty"
    [[ $(stat -c '%u' "$dir/$f") == "$uid" ]] || die "$dir/$f must belong to uid $uid"
    mode="$(stat -c '%a' "$dir/$f")"
    [[ $mode =~ ^[46]00$ ]] || die "$dir/$f must be readable by its owner only (mode $mode, expected 400)"
  done
}

# Run inside the Finance container (node -e) with WANT=none|production|simulation: exit 0 only when
# its bank connection is exactly that — the environment, the paths, every file readable by the
# Finance process and the mount read-only. No request is sent, nothing is printed.
# shellcheck disable=SC2016 # JavaScript
readonly RB_PREMIUM_VERIFY_JS='
  const fs = require("node:fs");
  const e = process.env;
  const dir = "/run/secrets/rb-premium";
  if (e.WANT === "none") process.exit(e.RB_PREMIUM_ENVIRONMENT === undefined && !fs.existsSync(dir) ? 0 : 2);
  if (e.RB_PREMIUM_ENVIRONMENT !== e.WANT || e.RB_PREMIUM_P12_FILE !== dir + "/certificate.p12") process.exit(3);
  const files = ["client-id", "certificate.p12", "p12-passphrase"];
  if (e.WANT === "simulation") {
    if (e.RB_PREMIUM_SIMULATION_CA_FILE !== dir + "/simulation-ca.crt") process.exit(5);
    files.push("simulation-ca.crt");
  } else if (e.RB_PREMIUM_SIMULATION_CA_FILE !== undefined) process.exit(5);
  for (const f of files) fs.accessSync(dir + "/" + f, fs.constants.R_OK);
  try { fs.writeFileSync(dir + "/.w", ""); process.exit(4); } catch {}'
