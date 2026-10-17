#!/usr/bin/env bash
# AYVO OS — back up and restore the edge (Caddy) of the DEV preview exactly as it RUNS (ADR 0026).
#
#   scripts/dev-edge-backup.sh backup  PROJECT BACKUP_ROOT ENV_FILE   prints the backup directory
#   scripts/dev-edge-backup.sh restore BACKUP_DIR ENV_FILE
#
# backup — taken by scripts/deploy-dev.sh before it changes the edge; any failure stops the
# deployment before the switch. It saves, from the running caddy container of PROJECT:
#   compose.yml   the Compose file the container was created from: the file at its config_files
#                 path, or — if that is already newer — the same path in git at the deployed commit
#   runtime.env   AYVO_IMAGE_TAG and (after ADR 0026) DEV_TAILNET_IPV4 as the container got them
#   <bind files>  every bind-mounted file under the project directory, read from INSIDE the running
#                 container (what Caddy really uses), at the same relative path
#   tag           the image tag of the running api/web (AYVO_IMAGE_TAG)
#   ports         the published ports of the running caddy
#   caddy.json    `docker inspect` of the container
#   SHA256SUMS    checksums of the above; COMPLETE is written last, after verification
# Verification: the copies match the container's files, and the saved compose.yml, rendered with
# ENV_FILE and runtime.env only, yields the running caddy's image and exactly its published ports.
#
# restore — puts that caddy back: removes the project's containers whose service the saved
# compose.yml does not define (e.g. the tailnet DNS), recreates caddy from the backup directory
# (no build, no other service touched) and checks that its published ports equal the saved ones.
# Works after a partly failed switch too (new caddy missing, unhealthy or half-created).
set -Eeuo pipefail
umask 077

die() {
  printf 'dev-edge-backup: %s\n' "$*" >&2
  exit 1
}

# Published ports of a container as sorted "HostIp:HostPort->port/proto" lines. Docker lists an
# all-addresses binding twice (0.0.0.0 and ::); both are written as 0.0.0.0, like Compose does.
ports_of() {
  docker inspect "$1" | jq -r '.[0].NetworkSettings.Ports // {} | to_entries[]
    | select(.value != null) | .key as $t | .value[]
    | "\(if .HostIp == "::" or .HostIp == "" then "0.0.0.0" else .HostIp end):\(.HostPort)->\($t)"' | sort -u
}

# Published ports of service caddy in a rendered Compose config (same format).
ports_of_config() {
  jq -r '.services.caddy.ports // [] | .[]
    | "\(.host_ip // "0.0.0.0"):\(.published)->\(.target)/\(.protocol // "tcp")"' | sort -u
}

caddy_container() {
  local ids
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=caddy")"
  [[ -n $ids && $(wc -l <<<"$ids") == 1 ]] || die "expected exactly one running caddy container in project $1"
  printf '%s' "$ids"
}

# Variables that the deploy process exports and Compose interpolates, but that are not in the env
# file. They are saved with the backup (runtime.env) and every render/restore uses exactly those,
# in a clean environment — never whatever the current shell happens to export (TS33-R4).
readonly RUNTIME_VARS=(AYVO_IMAGE_TAG DEV_TAILNET_IPV4 AYVO_EDGE_COMMIT)

# compose DIR FILE ENV ARGS… — Docker Compose with the env file plus DIR/runtime.env only.
compose_in() {
  local dir=$1 file=$2 env=$3
  shift 3
  local -a unset_vars=()
  local v
  for v in "${RUNTIME_VARS[@]}"; do unset_vars+=(-u "$v"); done
  env "${unset_vars[@]}" docker compose --project-directory "$dir" -f "$file" \
    --env-file "$env" --env-file "$dir/runtime.env" "$@"
}

backup() {
  local project=$1 root=$2 env=$3 cid workdir files dir dest src rel tag image sums ip
  [[ -f $env ]] || die "env file not found: $env"
  cid="$(caddy_container "$project")"
  label() { docker inspect --format "{{ index .Config.Labels \"$1\" }}" "$cid"; }
  workdir="$(label com.docker.compose.project.working_dir)"
  files="$(label com.docker.compose.project.config_files)"
  [[ -n $workdir && -n $files && $files != *,* ]] ||
    die "the caddy container does not name one Compose file (got '$files')"

  mkdir -p "$root"
  dir="$(mktemp -d "$root/edge-before-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"
  docker inspect "$cid" >"$dir/caddy.json"

  # Bind-mounted files below the project directory, as the container sees them now.
  while IFS=$'\t' read -r src dest; do
    [[ $src == "$workdir"/* ]] || continue
    rel=${src#"$workdir"/}
    mkdir -p "$dir/$(dirname "$rel")"
    docker exec "$cid" cat "$dest" >"$dir/$rel" || die "cannot read $dest from the running caddy"
    [[ "$(docker exec "$cid" sha256sum "$dest" | cut -d' ' -f1)" == "$(sha256sum "$dir/$rel" | cut -d' ' -f1)" ]] ||
      die "copy of $dest differs from the running container"
  done < <(jq -r '.[0].Mounts[] | select(.Type == "bind") | "\(.Source)\t\(.Destination)"' "$dir/caddy.json")

  image="$(jq -r '.[0].Config.Image' "$dir/caddy.json")"
  tag="$(docker inspect --format '{{.Config.Image}}' "$project-api-1" 2>/dev/null | sed -n 's/^[^:]*:\(.*\)$/\1/p')"
  [[ -n $tag ]] || die "cannot determine the running api image tag"
  printf '%s\n' "$tag" >"$dir/tag"
  ports_of "$cid" >"$dir/ports"
  [[ -s $dir/ports ]] || die "the running caddy publishes no ports"

  # Runtime values exactly as the running caddy got them (no current shell export involved).
  ip="$(jq -r '.[0].Config.Env[] | select(startswith("DEV_TAILNET_IPV4=")) | sub("^[^=]*="; "")' "$dir/caddy.json")"
  {
    printf 'AYVO_IMAGE_TAG=%s\n' "$tag"
    [[ -z $ip ]] || printf 'DEV_TAILNET_IPV4=%s\n' "$ip"
  } >"$dir/runtime.env"

  # The Compose file the running caddy was created from. The file at its path may already be newer
  # (checkout updated to a new main before the switch — TS33-R3), so the candidates are: that file,
  # then the same path in git at the commit recorded on the container (com.ayvo.edge-commit), then
  # at the commit in the image tag (<sha12>-<time>). The first one that reproduces the running
  # caddy — same image, exactly the same ports — is saved; none ⇒ no backup.
  local repo relpath commit candidate source="" rendered
  local -a candidates=()
  [[ ! -f $files ]] || candidates+=("disk")
  repo="$(git -C "$workdir" rev-parse --show-toplevel 2>/dev/null)" || repo=""
  if [[ -n $repo ]]; then
    relpath="$(realpath -m --relative-to="$repo" "$files")"
    for commit in "$(label com.ayvo.edge-commit)" "$(sed -n 's/^\([0-9a-f]\{12\}\)-.*/\1/p' <<<"$tag")"; do
      [[ $commit =~ ^[0-9a-f]{12,40}$ ]] && candidates+=("git:$commit")
    done
  fi
  for candidate in "${candidates[@]}"; do
    if [[ $candidate == disk ]]; then
      cp "$files" "$dir/compose.candidate"
    else
      git -C "$repo" show "${candidate#git:}:$relpath" >"$dir/compose.candidate" 2>/dev/null || continue
    fi
    rendered="$(compose_in "$dir" "$dir/compose.candidate" "$env" config --format json 2>/dev/null)" || continue
    [[ "$(jq -r '.services.caddy.image' <<<"$rendered")" == "$image" ]] || continue
    diff -q <(ports_of_config <<<"$rendered") "$dir/ports" >/dev/null || continue
    mv "$dir/compose.candidate" "$dir/compose.yml"
    source=$candidate
    break
  done
  rm -f "$dir/compose.candidate"
  [[ -n $source ]] ||
    die "no Compose file (${candidates[*]:-none}) reproduces the running caddy ($image, $(paste -sd' ' "$dir/ports")); backup refused"

  sums="$(cd "$dir" && find . -type f -print0 | sort -z | xargs -0 sha256sum)"
  printf '%s\n' "$sums" >"$dir/SHA256SUMS"
  printf 'project=%s\nimage=%s\ntag=%s\ncompose=%s\n' "$project" "$image" "$tag" "$source" >"$dir/COMPLETE"
  printf '%s\n' "$dir"
}

restore() {
  local dir=$1 env=$2 project id svc saved now
  [[ -f $dir/COMPLETE ]] || die "$dir is not a complete edge backup"
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || die "checksums in $dir do not match"
  project="$(sed -n 's/^project=//p' "$dir/COMPLETE")"
  saved="$(sed -n 's/^DEV_TAILNET_IPV4=//p' "$dir/runtime.env")"
  if [[ -n $saved ]] && command -v tailscale >/dev/null; then
    now="$(tailscale ip -4 2>/dev/null | head -n1)" || now=""
    [[ $now == "$saved" ]] || printf 'dev-edge-backup: warning: the saved tailnet address %s is not the current one (%s)\n' "$saved" "${now:-none}" >&2
  fi
  local -a C=(compose_in "$dir" "$dir/compose.yml" "$env" -p "$project")

  # Containers of services that did not exist before the switch (e.g. dns) go away.
  local defined
  defined="$("${C[@]}" config --services)" || die "the saved compose.yml does not render"
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    svc="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")"
    grep -qxF "$svc" <<<"$defined" || docker rm -f "$id" >/dev/null
  done

  "${C[@]}" up --detach --no-deps --no-build --force-recreate caddy
  diff -q <(ports_of "$(caddy_container "$project")") "$dir/ports" >/dev/null ||
    die "restored caddy does not publish the saved ports"
  printf 'dev-edge-backup: caddy restored from %s (ports as before)\n' "$dir"
}

for cmd in docker jq sha256sum git realpath; do command -v "$cmd" >/dev/null || die "required command not found: $cmd"; done
case ${1:-} in
  backup) (($# == 4)) || die "usage: $0 backup PROJECT BACKUP_ROOT ENV_FILE"; backup "$2" "$3" "$4" ;;
  restore) (($# == 3)) || die "usage: $0 restore BACKUP_DIR ENV_FILE"; restore "$2" "$3" ;;
  *) die "usage: $0 backup PROJECT BACKUP_ROOT ENV_FILE | restore BACKUP_DIR ENV_FILE" ;;
esac
