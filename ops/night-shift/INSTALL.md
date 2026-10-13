# Installing the extended night shift (separate, owner-approved step — doc 024 §10)

Nothing here runs automatically. The owner performs these steps in their own SSH session after
the PR is merged and the decisions of doc 024 §11 are made. Paths are the live ones.

1. **Pause the schedule** (keeps any running job intact): comment the line below
   `# AYVO Night Shift — managed block` in `crontab -e`.
2. **Trust anchor** (root-owned; the `ayvo` user and the model can never change it):

   ```bash
   sudo install -d -m 755 -o root -g root /etc/ayvo/night-shift
   printf 'ayvo-owner namespaces="ayvo-night-shift-run" %s\n' "$(cat owner-approval-key.pub)" \
     | sudo tee /etc/ayvo/night-shift/allowed_signers >/dev/null
   sudo chown root:root /etc/ayvo/night-shift/allowed_signers
   sudo chmod 644 /etc/ayvo/night-shift/allowed_signers
   ```

3. **Verification password** (only if decision 4 is yes): create
   `/opt/ayvo/secrets/night-shift/dev-verify.pass` (dir 700, file 600, owner `ayvo`) with the DEV
   Basic Auth password on the first line, typed without echo — never via chat or argv.
4. **Code:** copy `ops/night-shift/{night_shift,bin,Dockerfile,OPERATIONS.md}` of the merged commit
   to `/opt/ayvo/night-shift/` (keep `queue/`, `jobs/`, `state.json`, `logs/`, `reports/`), install
   `bin/ayvo-night-shift` as `/opt/ayvo/bin/ayvo-night-shift` (mode 700), create `approved/`,
   `runs/`, `revoked/` (mode 700), and refresh `MANIFEST.sha256`.
5. **Stale job:** move `queue/running/20261012-product-catalog-bom.json` to `queue/cancelled/`
   and set `state.json` to `{"phase": "idle"}` (decision 7).
6. **Check:** `ayvo-night-shift check` and `cd /opt/ayvo/night-shift && python3 -m unittest discover -s tests`
   (copy `tests/` too, or run them from the repository).
7. **Resume the schedule** (uncomment the crontab line).

A run is then started by placing `manifest.json`, `manifest.json.sig` and the part task files in
`/opt/ayvo/night-shift/approved/<run_id>/`; `ayvo-night-shift delivery verify …` checks it without
side effects.
