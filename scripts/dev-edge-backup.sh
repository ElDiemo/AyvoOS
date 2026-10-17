#!/usr/bin/env bash
# AYVO OS — back up and restore the edge (Caddy) of the DEV preview exactly as it RUNS (ADR 0026).
#
#   scripts/dev-edge-backup.sh backup  PROJECT BACKUP_ROOT ENV_FILE   prints the backup directory
#   scripts/dev-edge-backup.sh restore BACKUP_DIR ENV_FILE
#
# backup — taken by scripts/deploy-dev.sh before it changes the edge; any failure stops the
# deployment before the switch. It saves, from the running caddy container of PROJECT:
#   compose.yml   the Compose file the container was created from (its config_files label)
#   <bind files>  every bind-mounted file under the project directory, read from INSIDE the running
#                 container (what Caddy really uses), at the same relative path
#   tag           the image tag of the running api/web (AYVO_IMAGE_TAG)
#   ports         the published ports of the running caddy
#   caddy.json    `docker inspect` of the container
#   SHA256SUMS    checksums of the above; COMPLETE is written last, after verification
# Verification: the copies match the container's files, and the saved compose.yml, rendered with
# ENV_FILE and the tag, yields the running caddy's image and exactly its published ports.
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

backup() {
  local project=$1 root=$2 env=$3 cid workdir files dir dest src rel tag image sums
  [[ -f $env ]] || die "env file not found: $env"
  cid="$(caddy_container "$project")"
  label() { docker inspect --format "{{ index .Config.Labels \"$1\" }}" "$cid"; }
  workdir="$(label com.docker.compose.project.working_dir)"
  files="$(label com.docker.compose.project.config_files)"
  [[ -n $workdir && -n $files && $files != *,* && -f $files ]] ||
    die "the caddy container does not name one existing Compose file (got '$files')"

  mkdir -p "$root"
  dir="$(mktemp -d "$root/edge-before-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"
  cp "$files" "$dir/compose.yml"
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

  # The saved compose.yml must reproduce the running caddy: same image, exactly the same ports.
  local rendered
  rendered="$(AYVO_IMAGE_TAG=$tag docker compose --project-directory "$dir" -f "$dir/compose.yml" \
    --env-file "$env" config --format json 2>/dev/null)" || die "the saved compose.yml does not render with $env"
  [[ "$(jq -r '.services.caddy.image' <<<"$rendered")" == "$image" ]] ||
    die "the saved compose.yml names another caddy image than the running $image"
  diff -q <(ports_of_config <<<"$rendered") "$dir/ports" >/dev/null ||
    die "the saved compose.yml publishes other ports than the running caddy"

  sums="$(cd "$dir" && find . -type f -print0 | sort -z | xargs -0 sha256sum)"
  printf '%s\n' "$sums" >"$dir/SHA256SUMS"
  printf 'project=%s\nimage=%s\ntag=%s\n' "$project" "$image" "$tag" >"$dir/COMPLETE"
  printf '%s\n' "$dir"
}

restore() {
  local dir=$1 env=$2 project tag id svc
  [[ -f $dir/COMPLETE ]] || die "$dir is not a complete edge backup"
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || die "checksums in $dir do not match"
  project="$(sed -n 's/^project=//p' "$dir/COMPLETE")"
  tag="$(sed -n 's/^tag=//p' "$dir/COMPLETE")"
  local -a C=(docker compose -p "$project" --project-directory "$dir" -f "$dir/compose.yml" --env-file "$env")

  # Containers of services that did not exist before the switch (e.g. dns) go away.
  local defined
  defined="$(AYVO_IMAGE_TAG=$tag "${C[@]}" config --services)"
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    svc="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")"
    grep -qxF "$svc" <<<"$defined" || docker rm -f "$id" >/dev/null
  done

  AYVO_IMAGE_TAG=$tag "${C[@]}" up --detach --no-deps --no-build --force-recreate caddy
  diff -q <(ports_of "$(caddy_container "$project")") "$dir/ports" >/dev/null ||
    die "restored caddy does not publish the saved ports"
  printf 'dev-edge-backup: caddy restored from %s (ports as before)\n' "$dir"
}

for cmd in docker jq sha256sum; do command -v "$cmd" >/dev/null || die "required command not found: $cmd"; done
case ${1:-} in
  backup) (($# == 4)) || die "usage: $0 backup PROJECT BACKUP_ROOT ENV_FILE"; backup "$2" "$3" "$4" ;;
  restore) (($# == 3)) || die "usage: $0 restore BACKUP_DIR ENV_FILE"; restore "$2" "$3" ;;
  *) die "usage: $0 backup PROJECT BACKUP_ROOT ENV_FILE | restore BACKUP_DIR ENV_FILE" ;;
esac
