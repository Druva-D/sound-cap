#!/bin/sh
# Regenerates PNG icons from the SVG sources (needs rsvg-convert).
set -e
cd "$(dirname "$0")/../icons"
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 maskable.svg -o maskable-512.png
rsvg-convert -w 180 -h 180 maskable.svg -o apple-touch-icon.png
