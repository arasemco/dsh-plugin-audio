#!/usr/bin/env bash
# =============================================================================
# next-version.sh — the next semver, from the commits since the last release.
#
# Conventional Commits, highest wins:
#   type(scope)!: ... or a "BREAKING CHANGE" subject  → major
#   feat: ...                                         → minor
#   anything else                                     → patch
#   nothing new since the last release                → bump=none
#
# The base is the newer of the highest released tag and the version the manifest
# already declares: a manifest ahead of every tag is a version that was never
# released, and the next release must be greater than it. A computed version
# whose tag already exists is bumped again, so a re-run never collides.
#
# Prints GitHub Actions outputs:
#   version=<x.y.z>  bump=<major|minor|patch|none>  last=<previous tag or v0.0.0>
# Run it by hand to see what the next release would be.
# =============================================================================
set -euo pipefail

# The two version sources: the highest tag and the manifest's own version.
last="$(git tag -l 'v*' --sort=-v:refname | head -1)"
if [ -n "${last}" ]; then
    tag_version="${last#v}"
    tag_version="${tag_version%%-*}"
else
    last='v0.0.0'
    tag_version='0.0.0'
fi
manifest_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
manifest_version="${manifest_version%%-*}"
manifest_version="${manifest_version:-0.0.0}"

base="$(printf '%s\n%s\n' "${tag_version}" "${manifest_version}" | sort -V | tail -1)"

if git rev-parse -q --verify "refs/tags/${last}" >/dev/null; then
    subjects="$(git log --format=%s "${last}..HEAD")"
else
    subjects="$(git log --format=%s HEAD)"
fi

if [ -z "${subjects}" ]; then
    printf 'version=%s\nbump=none\nlast=%s\n' "${base}" "${last}"
    exit 0
fi

bump='patch'
if printf '%s\n' "${subjects}" | grep -qE '^[a-zA-Z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE'; then
    bump=major
elif printf '%s\n' "${subjects}" | grep -qE '^feat(\([^)]*\))?:'; then
    bump=minor
fi

IFS='.' read -r major minor patch <<< "${base}"
case "${bump}" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
esac
next="${major}.${minor}.${patch}"

# A tag for the computed version can only exist when the manifest already
# declared it; keep bumping until the tag is free.
while git rev-parse -q --verify "refs/tags/v${next}" >/dev/null; do
    major="${next%%.*}"
    rest="${next#*.}"
    minor="${rest%%.*}"
    patch=$(( ${rest#*.} + 1 ))
    next="${major}.${minor}.${patch}"
done

printf 'version=%s\nbump=%s\nlast=%s\n' "${next}" "${bump}" "${last}"
