#!/usr/bin/env bash
# setup-mount-permissions.sh
#
# Configures udisks2 to mount exFAT drives with read/write permissions
# for the current user, so the MODAQ Uploader can delete local files.
#
# Usage:  sudo ./setup-mount-permissions.sh [username]

set -euo pipefail

USER="${1:-${SUDO_USER:-}}"

if [ -z "$USER" ]; then
    echo "Error: Could not determine target user."
    echo "Usage: sudo $0 [username]"
    exit 1
fi

UID_NUM=$(id -u "$USER")
GID_NUM=$(id -g "$USER")

CONF="/etc/udisks2/mount_options.conf"

mkdir -p /etc/udisks2

cat > "$CONF" << EOF
# MODAQ Uploader — mount exFAT drives with rw for $USER
[defaults]
exfat_defaults=uid=$UID_NUM,gid=$GID_NUM,dmask=0022,fmask=0133
EOF

echo "Written: $CONF"
echo "exFAT drives will now mount with rw for $USER (uid=$UID_NUM)."
echo ""
echo "Unplug and re-plug the drive to apply."
