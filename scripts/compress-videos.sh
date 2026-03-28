#!/usr/bin/env bash
# Compress project videos using ffmpeg before uploading to R2.
#
# Prerequisites:
#   Install ffmpeg: brew install ffmpeg  (macOS) / sudo apt install ffmpeg (Linux)
#
# Usage:
#   ./scripts/compress-videos.sh
#
# This creates compressed copies alongside originals with a .compressed.mp4 suffix,
# then replaces the originals. Original files are backed up to a temp directory.
#
# Encoding settings:
#   - H.264 (libx264) for maximum compatibility
#   - CRF 28 (good quality, much smaller file size)
#   - Cover videos: max 720p, 2 Mbps (they're just thumbnails/previews)
#   - Content videos: max 1080p, 4 Mbps

set -euo pipefail

ASSETS_DIR="src/assets/projects"
BACKUP_DIR="/tmp/video-backup-$(date +%s)"

if ! command -v ffmpeg &> /dev/null; then
    echo "Error: ffmpeg not found. Install it first."
    exit 1
fi

mkdir -p "$BACKUP_DIR"
echo "Backups will be saved to: $BACKUP_DIR"
echo "---"

compress_video() {
    local input="$1"
    local max_height="$2"
    local max_bitrate="$3"
    local output="${input%.mp4}.compressed.mp4"
    local relative="${input#$ASSETS_DIR/}"

    # Get original size
    local original_size
    original_size=$(stat -f%z "$input" 2>/dev/null || stat -c%s "$input" 2>/dev/null)
    local original_mb=$((original_size / 1024 / 1024))

    echo "Compressing: $relative (${original_mb}MB)"

    ffmpeg -i "$input" \
        -c:v libx264 \
        -crf 28 \
        -preset slow \
        -vf "scale=-2:'min($max_height,ih)'" \
        -maxrate "$max_bitrate" \
        -bufsize "$((${max_bitrate%k} * 2))k" \
        -c:a aac -b:a 128k \
        -movflags +faststart \
        -y -loglevel warning \
        "$output"

    local new_size
    new_size=$(stat -f%z "$output" 2>/dev/null || stat -c%s "$output" 2>/dev/null)
    local new_mb=$((new_size / 1024 / 1024))

    # Only replace if compressed is smaller
    if [ "$new_size" -lt "$original_size" ]; then
        cp "$input" "$BACKUP_DIR/$relative"
        mv "$output" "$input"
        echo "  -> ${original_mb}MB -> ${new_mb}MB (saved $((original_mb - new_mb))MB)"
    else
        rm "$output"
        echo "  -> Skipped (compressed would be larger)"
    fi
}

# Compress cover videos (720p max — they're just previews)
echo "=== Compressing cover videos (720p, 2Mbps) ==="
find "$ASSETS_DIR" -path "*/cover/*.mp4" -type f | sort | while read -r file; do
    compress_video "$file" 720 2000k
done

echo ""
echo "=== Compressing content videos (1080p, 4Mbps) ==="
find "$ASSETS_DIR" -path "*/videos/*.mp4" -type f | sort | while read -r file; do
    compress_video "$file" 1080 4000k
done

echo ""
echo "---"
echo "Done! Backups saved to: $BACKUP_DIR"
echo "Run ./scripts/upload-videos-to-r2.sh to upload compressed videos."
