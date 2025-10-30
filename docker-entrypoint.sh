#!/bin/sh
set -e

PACKS_DIR="${ASSETS_PACKS_DIR:-/usr/src/app/assets/packs}"
MIRROR_DIR="${ASSETS_MIRROR_DIR:-/usr/src/app/generated-packs}"

mkdir -p "${PACKS_DIR}"
mkdir -p "${MIRROR_DIR}"

# Adjust ownership; ignore errors if we do not have permission
if [ -d "${PACKS_DIR}" ]; then
  chown -R node:node "${PACKS_DIR}" 2>/dev/null || true
fi
if [ -d "${MIRROR_DIR}" ]; then
  chown -R node:node "${MIRROR_DIR}" 2>/dev/null || true
fi

exec su-exec node "$@"
