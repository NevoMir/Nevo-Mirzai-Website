#!/usr/bin/env bash
# Upload all project videos to a Cloudflare R2 bucket.
#
# Prerequisites:
#   1. Install Wrangler:  npm install -g wrangler
#   2. Authenticate:      wrangler login
#   3. Create your R2 bucket in the Cloudflare dashboard (or via CLI):
#        wrangler r2 bucket create my-website-videos
#
# Usage:
#   ./scripts/upload-videos-to-r2.sh <bucket-name>
#
# Example:
#   ./scripts/upload-videos-to-r2.sh my-website-videos
#
# This will upload files preserving the structure:
#   <bucket>/<project-slug>/cover/cover.mp4
#   <bucket>/<project-slug>/videos/demo.mp4
#   etc.

set -euo pipefail

BUCKET="${1:?Usage: $0 <r2-bucket-name>}"
ASSETS_DIR="src/assets/projects"

if command -v wrangler &> /dev/null; then
    WRANGLER="wrangler"
elif npx wrangler --version &> /dev/null; then
    WRANGLER="npx wrangler"
else
    echo "Error: wrangler CLI not found. Install it with: npm install -g wrangler"
    exit 1
fi

VIDEO_EXTENSIONS="mp4|webm|mov|m4v|ogg"

echo "Uploading videos from $ASSETS_DIR to R2 bucket: $BUCKET"
echo "---"

count=0

find "$ASSETS_DIR" -type f -regextype posix-extended -regex ".*\\.($VIDEO_EXTENSIONS)$" | sort | while read -r file; do
    # Extract path relative to assets dir: e.g. "aerial-am/cover/cover.mp4"
    relative="${file#$ASSETS_DIR/}"

    echo "Uploading: $relative"
    $WRANGLER r2 object put "$BUCKET/$relative" --file "$file" --content-type "video/mp4"
    count=$((count + 1))
done

echo "---"
echo "Done! Uploaded videos to R2 bucket '$BUCKET'."
echo ""
echo "Next steps:"
echo "  1. Make the bucket public in Cloudflare dashboard:"
echo "     R2 > your bucket > Settings > Public access > Enable"
echo "     You'll get a URL like: https://pub-xxxx.r2.dev"
echo "  2. (Optional) Connect a custom domain like videos.yourdomain.com"
echo "  3. Set the env variable in your .env file or Cloudflare Pages settings:"
echo "     VITE_R2_PUBLIC_URL=https://pub-xxxx.r2.dev"
echo "  4. Remove tracked videos from git:"
echo "     git rm -r --cached 'src/assets/projects/*/cover/*.mp4'"
echo "     git rm -r --cached 'src/assets/projects/*/videos/*.mp4'"
echo "     git commit -m 'Remove videos from git (now hosted on R2)'"
