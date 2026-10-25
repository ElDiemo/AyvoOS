# AYVO marketing site (ADR 0040): the static files and their Caddy config, nothing else.
# Build context: apps/marketing. Runs as an unprivileged user on a read-only filesystem.
FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY Caddyfile /etc/caddy/Caddyfile
COPY site /srv
# The content digest of this release, computed the same way as from the repository.
COPY site-digest.sh /usr/local/bin/site-digest
# Port 8080 needs no capability: drop the binary's file capability (cap_net_bind_service), so it
# runs with every capability dropped and no-new-privileges.
RUN setcap -r /usr/bin/caddy \
	&& caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
	&& find /srv -type d -exec chmod 0555 {} + \
	&& find /srv -type f -exec chmod 0444 {} +
ENV XDG_CONFIG_HOME=/tmp/config XDG_DATA_HOME=/tmp/data
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=20s --start-interval=1s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
