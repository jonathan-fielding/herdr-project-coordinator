#!/bin/sh
# A stand-in for Claude as a coordinator: no tokens. Config command: /bin/sh fake-claude.sh <log>.
# Appends the arguments it was started with to <log>, reports an idle status over OSC 7501 (unless
# <log>.silent exists: like Claude at its trust question, it then reports none), then hangs.
log=$1
shift
printf '%s\n' "$*" >> "$log"
[ -e "$log.silent" ] || printf '\033]7501;state=idle\007'
exec sleep 600
