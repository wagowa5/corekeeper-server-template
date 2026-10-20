#!/bin/bash
set -Eeuo pipefail
exec 9>/run/corekeeper-backup.lock
flock -n 9 || { echo 'Another backup is running' >&2; exit 1; }
leave_stopped=false
if [[ ${1:-} == --leave-stopped ]]; then leave_stopped=true; elif [[ $# != 0 ]]; then exit 2; fi
source_dir=/srv/corekeeper/server-data
mountpoint -q /srv/corekeeper
# Refuse an empty/new world: never upload a misleading empty backup.
test -s "$source_dir/worlds/0.world.gzip"
readarray -t config < <(python3 - <<'PY'
import json
c=json.load(open('/etc/corekeeper/config.json'))
print(c['bucket']); print(c['region'])
PY
)
was_active=false
systemctl is-active --quiet corekeeper && was_active=true
archive=$(mktemp /var/tmp/corekeeper-XXXXXXXX.tar.gz)
success=false
cleanup() {
  status=$?
  trap - EXIT
  if $was_active && { ! $success || ! $leave_stopped; }; then
    systemctl start corekeeper || status=1
  fi
  if $success; then rm -f "$archive"; else echo "Backup failed; local archive retained: $archive" >&2; fi
  exit "$status"
}
trap cleanup EXIT
systemctl stop corekeeper
# Docker reports 137 when its grace period ended in SIGKILL. Do not bless that save.
exit_code=$(docker inspect --format '{{.State.ExitCode}}' core-keeper-dedicated)
if [[ "$exit_code" == 137 ]]; then echo 'Server was force-killed; refusing backup' >&2; exit 1; fi
if [[ $(docker inspect --format '{{.State.Running}}' core-keeper-dedicated) != false ]]; then exit 1; fi
tar -C /srv/corekeeper -czf "$archive" server-data
key="corekeeper/backups/corekeeper-$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid).tar.gz"
aws s3 cp "$archive" "s3://${config[0]}/$key" --region "${config[1]}" --only-show-errors
success=true
echo "Backup uploaded: $key"
