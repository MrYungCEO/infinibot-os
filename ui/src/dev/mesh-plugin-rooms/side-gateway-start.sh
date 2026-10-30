#!/bin/bash
# Isolated side gateway for the plugin-rooms verification: fresh HOME + state
# dir, no secrets, channels/cron/tunnel/federation off, all egress denied via a
# dead proxy. Serves the worktree's dist on :$SIDE_PORT (default 18977).
D=/tmp/mesh-plugin-rooms/side; W=/tmp/ib-mesh-plugin-rooms; N=${NODE_BIN_DIR:-$(dirname "$(command -v node)")}; P=${SIDE_PORT:-18977}
cd $W && env -i PATH="$N:/usr/local/bin:/usr/bin:/bin" HOME="$D/home" USER="${USER:-dev}" LANG=C.UTF-8 TERM=xterm-256color TMUX_TMPDIR="$D/tmux" \
  INFINIBOT_STATE_DIR="$D/state" INFINIBOT_CONFIG_PATH="$D/state/infinibot.json" INFINIBOT_GATEWAY_PORT=$P INFINIBOT_PORT=$P \
  INFINIBOT_ALLOW_MULTI=1 INFINIBOT_ALLOW_MULTI_GATEWAY=1 INFINIBOT_SKIP_CHANNELS=1 INFINIBOT_SKIP_CRON=1 INFINIBOT_SKIP_TUNNEL=1 INFINIBOT_SKIP_AUTO_UPDATE=1 \
  INFINIBOT_SKIP_CLAUDE_CODE_REGISTER=1 INFINIBOT_SKIP_CLAUDE_CODE_WATCHER=1 INFINIBOT_DISABLE_BONJOUR=1 INFINIBOT_SKIP_GMAIL_WATCHER=1 INFINIBOT_SKIP_EMAIL_INBOUND=1 \
  INFINIBOT_SKIP_FEDERATION_INTEGRATION=1 INFINIBOT_SKIP_BROWSER_CONTROL_SERVER=1 INFINIBOT_SKIP_CANVAS_HOST=1 INFINIBOT_VERIFY_TELEGRAM=off INFINIBOT_DISABLE_AUTH=1 \
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  NODE_ENV=production nohup $N/node $W/dist/entry.js gateway > $D/gw.log 2>&1 &
echo "started pid=$!"
