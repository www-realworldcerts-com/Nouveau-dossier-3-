#!/usr/bin/env bash
# NOTE: This is the exact same script that the workflow writes and runs on the VM.
# Keep this file in your repository if you prefer to review or update the remote bootstrap logic locally.

set -euxo pipefail

RUNNER_TOKEN="${1:-}"
TAILSCALE_AUTHKEY="${2:-}"
GH_REPO="${3:-}"

# Update and install required packages
sudo apt-get update -y
sudo apt-get install -y curl jq ca-certificates tar

# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key "${TAILSCALE_AUTHKEY}" --advertise-exit-node --ssh || true

# Install GitHub Actions runner
RUNNER_DIR="/opt/actions-runner"
sudo mkdir -p "${RUNNER_DIR}"
sudo chown "$(whoami)":"$(whoami)" "${RUNNER_DIR}"
pushd "${RUNNER_DIR}"

ARCH="$(uname -m)"
if [ "${ARCH}" = "x86_64" ]; then
  RUNNER_ARCH="x64"
elif [ "${ARCH}" = "aarch64" ] || [ "${ARCH}" = "arm64" ]; then
  RUNNER_ARCH="arm64"
else
  RUNNER_ARCH="x64"
fi

# Use a pinned runner release; update if you want newer
RUNNER_VERSION="2.308.0"
TARBALL="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

curl -fsSL -o "${TARBALL}" "${URL}"
tar xzf "${TARBALL}"

RUNNER_NAME="egress-$(hostname)-$(date +%s)"
./config.sh --url "https://github.com/${GH_REPO}" --token "${RUNNER_TOKEN}" --labels "self-hosted,egress" --name "${RUNNER_NAME}" --unattended

sudo ./svc.sh install
sudo ./svc.sh start
popd

# Create /opt/egress-ip.json with the VM public IP for artifact
PUBLIC_IP="$(curl -fsSL https://api.ipify.org || true)"
sudo mkdir -p /opt
echo "{\"ip\": \"${PUBLIC_IP}\"}" | sudo tee /opt/egress-ip.json >/dev/null
sudo chown root:root /opt/egress-ip.json