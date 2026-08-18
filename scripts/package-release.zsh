#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
cd "$project_dir"

version="$(node -p 'require("./package.json").version')"
name="$(node -p 'require("./package.json").name')"
release_name="$name-v$version"
dist_dir="$project_dir/dist"
staging_dir="$dist_dir/$release_name"
archive="$dist_dir/$release_name.tgz"

npm run check
npm test

rm -rf "$staging_dir" "$archive" "$archive.sha256"
mkdir -p "$staging_dir" "$dist_dir"

for item in README.md AGENTS.md package.json package-lock.json config.example.json .gitignore .npmignore src scripts support test docs; do
  cp -R "$item" "$staging_dir/"
done

find "$staging_dir" -name '.DS_Store' -delete
find "$staging_dir" -type f \( -name '*.log' -o -name '.env' -o -name '.env.*' \) -delete
rm -rf "$staging_dir/node_modules" "$staging_dir/.data" "$staging_dir/logs" "$staging_dir/dist"

tar -C "$dist_dir" -czf "$archive" "$release_name"
shasum -a 256 "$archive" > "$archive.sha256"

echo "Release archive: $archive"
echo "SHA256: $archive.sha256"
