#!/bin/sh
# Run before each deploy: gives index.html a new build number (date and time), used in the Version line and in every
# ?v= on the page's files, so browsers and caches fetch the new files instead of keeping old ones.
cd "$(dirname "$0")" || exit 1
B=$(date +%Y%m%d-%H%M)
sed -E -i.bak "s/[0-9]{8}-[0-9]{4}/$B/g" index.html && rm -f index.html.bak
echo "Build $B"
grep -c "$B" index.html | sed 's/^/  stamped in /; s/$/ places/'
