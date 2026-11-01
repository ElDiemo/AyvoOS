# shellcheck shell=bash
# AYVO OS — the one check of Finance's invoice mail settings, shared by the DEV and PROD deployments
# (doc 043 §5). Prints the reason and returns 1 when they are refused. Values are not secrets.
# usage: invoice_mail_settings_problem <driver> <recipients> <production: true|false>
invoice_mail_settings_problem() {
  local driver=$1 recipients=$2 production=$3 address
  case "$driver" in
    google-relay) ;;
    simulation)
      if [[ $production == true ]]; then
        printf 'FINANCE_INVOICE_MAIL=simulation does not exist in production\n'
        return 1
      fi
      ;;
    *)
      printf 'FINANCE_INVOICE_MAIL must be simulation or google-relay\n'
      return 1
      ;;
  esac
  if [[ $driver == google-relay && -z $recipients ]]; then
    printf 'FINANCE_MAIL_TEST_RECIPIENTS is required with google-relay (exact allowed addresses)\n'
    return 1
  fi
  if [[ -n $recipients ]]; then
    for address in ${recipients//,/ }; do
      if [[ ! $address =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]]; then
        printf 'FINANCE_MAIL_TEST_RECIPIENTS holds an invalid address\n'
        return 1
      fi
    done
  fi
}
