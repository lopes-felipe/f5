#!/usr/bin/env bash
# Builds the F5 Linux VM guest image from image.json and rootfs/. Runs on a Linux arm64
# host with libguestfs-tools, qemu-utils and jq (the vm-guest-image workflow).
#
#   build-image.sh <output-dir>
#
# Writes f5-guest-<imageVersion>-<source>-arm64.qcow2 and a matching .json with its SHA-256
# and size. Packages come from a pinned snapshot.debian.org timestamp, so a rebuild of the
# same commit installs the same package versions. Nothing in the image runs apt at runtime.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: build-image.sh <output-dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
spec="$here/image.json"
image_version=$(jq -r .imageVersion "$spec")
base_url=$(jq -r .base.url "$spec")
base_sha512=$(jq -r .base.sha512 "$spec")
snapshot=$(jq -r .aptSnapshot "$spec")
packages=$(jq -r '.packages | join(",")' "$spec")
guest_uid=$(jq -r .guestUid "$spec")
source=$(git -C "$here" rev-parse --short=12 HEAD 2>/dev/null || echo local)
name="f5-guest-${image_version}-${source}-arm64"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/base.qcow2" "$base_url"
echo "$base_sha512  $work/base.qcow2" | sha512sum --strict -c -
cp "$work/base.qcow2" "$work/image.qcow2"
qemu-img resize "$work/image.qcow2" 8G

jq -n --arg version "$image_version" --arg source "$source" --arg base "$base_url" \
  --arg snapshot "$snapshot" \
  '{imageVersion: ($version | tonumber), source: $source, base: $base, aptSnapshot: $snapshot}' \
  >"$work/image-info.json"

# Plain HTTP, as Debian ships by default: apt verifies every package against the InRelease
# files signed with the archive keyring in the base image, so TLS adds no integrity.
cat >"$work/sources.list" <<EOF
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${snapshot}/ trixie main
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${snapshot}/ trixie-updates main
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${snapshot}/ trixie-security main
EOF

export LIBGUESTFS_BACKEND=direct
# KVM doesn't work on GitHub's arm64 runners, even when /dev/kvm looks usable. libguestfs
# then asks QEMU for gic-version=host and the appliance dies at launch; force_tcg selects
# pure emulation. A host with working KVM can set LIBGUESTFS_BACKEND_SETTINGS= to skip it.
export LIBGUESTFS_BACKEND_SETTINGS=${LIBGUESTFS_BACKEND_SETTINGS-force_tcg}
# Under TCG the appliance boots with its clock at 1970, so apt rejects every signature as
# "not live until" its date. Before apt runs, the build sets the appliance clock from the host's.
verbose=()
if [ "${F5_IMAGE_BUILD_VERBOSE:-}" = 1 ]; then verbose=(-v -x); fi
rootfs="$here/rootfs"
virt-customize "${verbose[@]}" -a "$work/image.qcow2" --network \
  --run-command 'rm -f /etc/apt/sources.list.d/*' \
  --upload "$work/sources.list:/etc/apt/sources.list" \
  --run-command "date -u -s @$(date -u +%s)" \
  --run-command 'apt-get update --error-on=any' \
  --run-command "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $(echo "$packages" | tr , ' ')" \
  --run-command 'apt-get clean && rm -rf /var/lib/apt/lists/*' \
  --mkdir /opt/f5/bin \
  --upload "$rootfs/opt/f5/bin/f5-guest:/opt/f5/bin/f5-guest" \
  --upload "$rootfs/opt/f5/bin/f5-egress-apply:/opt/f5/bin/f5-egress-apply" \
  --upload "$rootfs/etc/systemd/system/f5-egress.service:/etc/systemd/system/f5-egress.service" \
  --upload "$work/image-info.json:/opt/f5/image.json" \
  --run-command 'chown -R root:root /opt/f5 /etc/systemd/system/f5-egress.service' \
  --run-command 'chmod 0755 /opt/f5 /opt/f5/bin /opt/f5/bin/f5-guest /opt/f5/bin/f5-egress-apply' \
  --run-command 'chmod 0644 /opt/f5/image.json /etc/systemd/system/f5-egress.service' \
  --run-command "useradd --no-create-home --home-dir /var/lib/f5/home --shell /bin/bash --uid $guest_uid --user-group f5" \
  --run-command 'if getent group sudo | grep -qw f5; then gpasswd -d f5 sudo; fi' \
  --run-command 'install -d -o root -g root -m 0755 /var/lib/f5' \
  --run-command 'systemctl enable f5-egress.service' \
  --run-command 'systemctl disable nftables.service || true' \
  --run-command 'sha256sum /opt/f5/bin/f5-guest /opt/f5/bin/f5-egress-apply /etc/systemd/system/f5-egress.service /opt/f5/image.json >/opt/f5/policy.sha256 && chmod 0644 /opt/f5/policy.sha256' \
  --run-command 'passwd -l root' \
  --truncate /etc/machine-id

# Compressed for download; Lima converts it to a raw disk for VZ on first use.
qemu-img convert -c -O qcow2 "$work/image.qcow2" "$out/$name.qcow2"
sha256=$(sha256sum "$out/$name.qcow2" | cut -d' ' -f1)
size=$(stat -c %s "$out/$name.qcow2")
jq -n --arg file "$name.qcow2" --arg sha256 "$sha256" --argjson size "$size" \
  --slurpfile info "$work/image-info.json" \
  '{file: $file, sha256: $sha256, size: $size} + $info[0]' >"$out/$name.json"
cat "$out/$name.json"
