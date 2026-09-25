#!/usr/bin/env bash
# One-time host setup for a fresh EC2 instance: Docker Engine + Compose plugin + git,
# the login user in the docker group, and 2 GB of swap on small instances.
# Supports Ubuntu (22.04/24.04) and Amazon Linux 2023. Idempotent.
#
#   curl -fsSL <raw url>/deploy/scripts/bootstrap-ec2.sh | sudo bash
#   # or, after cloning:  sudo bash deploy/scripts/bootstrap-ec2.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-${TARGET_USER:-}}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  if id ubuntu >/dev/null 2>&1; then TARGET_USER=ubuntu; else TARGET_USER=ec2-user; fi
fi

. /etc/os-release
echo "==> Detected $PRETTY_NAME; docker group user: $TARGET_USER"

install_compose_plugin_manual() {
  # Amazon Linux's docker package ships without the compose v2 plugin.
  local arch
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  # buildx >= 0.17 is required by recent compose for `compose build`.
  local bx
  bx="$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -oE '"tag_name": *"[^"]+"' | cut -d'"' -f4)"
  local bxarch=amd64; [ "$arch" = aarch64 ] && bxarch=arm64
  curl -fsSL "https://github.com/docker/buildx/releases/download/${bx}/buildx-${bx}.linux-${bxarch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-buildx
  chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
}

case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl git gnupg
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.asc ]; then
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ;;
  amzn)
    dnf install -y docker git
    if ! docker compose version >/dev/null 2>&1; then
      install_compose_plugin_manual
    fi
    ;;
  *)
    echo "Unsupported distribution: $ID (use Ubuntu or Amazon Linux 2023)" >&2
    exit 1
    ;;
esac

systemctl enable --now docker
usermod -aG docker "$TARGET_USER"

# Swap: `next build` and `nest build` peak well above 1 GB; on a 2 GB instance the
# build would be OOM-killed without it.
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 4000000 ] && ! swapon --show | grep -q '/swapfile'; then
  echo "==> RAM < 4 GB: creating 2 GB swap at /swapfile"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# Redis recommends overcommit so background saves (appendonly rewrite) don't fail.
sysctl -w vm.overcommit_memory=1 >/dev/null
grep -q '^vm.overcommit_memory' /etc/sysctl.conf || echo 'vm.overcommit_memory=1' >> /etc/sysctl.conf

docker --version
docker compose version
echo
echo "==> Done. Log out and back in (or run: newgrp docker) so '$TARGET_USER' can use docker without sudo."
