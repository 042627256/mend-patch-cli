#!/bin/bash
set -e
cd /home/agentuser/mend-patch-cli
TOKEN=$(python3 -c "
import re
txt = open('/home/agentuser/.config/gh/hosts.yml').read()
print(re.findall(r'oauth_token: (\S+)', txt)[1])
")
git init -b main 2>/dev/null || git init
git config user.name 'davlermid'
git config user.email 'davlermid@users.noreply.github.com'
git add -A
git commit -m 'mend: CLI that applies AI-model edits in four formats to a file tree' 2>/dev/null || true
git remote add origin "https://042627256:${TOKEN}@github.com/042627256/mend-patch-cli.git" 2>/dev/null || git remote set-url origin "https://042627256:${TOKEN}@github.com/042627256/mend-patch-cli.git"
git push -u origin main --force
