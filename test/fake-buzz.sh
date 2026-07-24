#!/bin/sh
# Test stub standing in for both `gh` and `buzz` CLIs, driven by FAKE_MODE.
EVENT_ID="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

case "$FAKE_MODE" in
  gh-red)
    echo '{"workflow_runs":[{"status":"completed","conclusion":"failure","run_number":42,"html_url":"https://github.com/o/r/actions/runs/42"}]}'
    ;;
  gh-green)
    echo '{"workflow_runs":[{"status":"completed","conclusion":"success","run_number":43,"html_url":"https://github.com/o/r/actions/runs/43"}]}'
    ;;
  buzz-pending)
    case "$1" in
      messages)  echo "{\"id\":\"$EVENT_ID\"}" ;;
      reactions) echo '[]' ;;
    esac
    ;;
  buzz-approved)
    case "$1" in
      messages)  echo "{\"id\":\"$EVENT_ID\"}" ;;
      reactions) echo '[{"emoji":"👍","count":1,"pubkeys":["f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f00f"]}]' ;;
    esac
    ;;
  *)
    echo "fake-buzz: unknown FAKE_MODE '$FAKE_MODE'" >&2
    exit 1
    ;;
esac
