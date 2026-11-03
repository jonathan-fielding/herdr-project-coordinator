#!/bin/sh
# A stand-in worker agent for integration tests: no tokens. hcoord passes the brief as the last
# argument (after Claude-style flags when the agent kind is "claude");
# the test puts KEY=value lines in the task brief to steer it:
#   BUN, CLI, HCOORD_HOME  how to run hcoord
#   GATE=<file>            wait until this file exists before doing anything
#   FILE=<name>            the file MODE=done writes (default work-<id>.txt): the same name in
#                          two tasks makes their merges conflict
#   MODE=done (default)    commit a file, report done, stay alive like an idle agent
#   MODE=exit              exit 7 without reporting
#   MODE=block             report "blocked" over OSC 7501, then hang
#   MODE=ask               report needs_you, read the answer from the terminal, then finish
#   MODE=dirty             report done with an uncommitted file (refused: noted in refused-<id>.txt),
#                          then commit it and report done again
#   MODE=nothing           report done without changing anything
#   MODE=trustprompt       show something like Claude's folder-trust dialog and hang, silent
for p; do :; done # p = last argument
field() { printf '%s\n' "$p" | sed -n "s/^$1=//p" | head -1; }
id=$(printf '%s\n' "$p" | sed -n 's/^Task: \([A-Z0-9]*-[0-9]*\) .*/\1/p' | head -1)
BUN=$(field BUN)
CLI=$(field CLI)
HCOORD_HOME=$(field HCOORD_HOME)
export HCOORD_HOME
hcoord() { "$BUN" "$CLI" "$@"; }
commit() {
  git add -A && git -c user.name=fake -c user.email=fake@example.com commit -qm "$id: $1"
}

gate=$(field GATE)
if [ -n "$gate" ]; then
  while [ ! -e "$gate" ]; do sleep 0.1; done
fi

case "$(field MODE)" in
  exit)
    exit 7
    ;;
  trustprompt)
    printf ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n'
    sleep 600
    ;;
  block)
    printf '\033]7501;state=blocked:kind=permission\007'
    sleep 600
    ;;
  dirty)
    echo "work for $id" > "work-$id.txt"
    if printf 'Done.\n' | hcoord report "$id" --state done --file - > /dev/null 2> "../refused-$id.txt"; then
      echo accepted > "../refused-$id.txt"
    fi
    commit "fake work"
    printf 'Done, committed.\n' | hcoord report "$id" --state done --file -
    sleep 600
    ;;
  nothing)
    printf 'Looked; nothing needed changing.\n' | hcoord report "$id" --state done --file -
    sleep 600
    ;;
  ask)
    printf 'Which colour should it be?\n\nOptions: red or blue.\n' | hcoord report "$id" --state needs_you --file -
    read -r answer
    echo "$answer" > "colour-$id.txt"
    commit "colour $answer"
    printf 'Used %s, as asked.\n' "$answer" | hcoord report "$id" --state done --file -
    sleep 600
    ;;
  *)
    file=$(field FILE)
    [ -n "$file" ] || file="work-$id.txt"
    echo "work for $id" > "$file"
    commit "fake work"
    printf 'Wrote %s.\n\nTested: nothing to test.\n' "$file" | hcoord report "$id" --state done --file -
    sleep 600
    ;;
esac
