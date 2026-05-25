#!/bin/zsh
set -e

cd "$(dirname "$0")"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 24.15.0 >/dev/null
fi

npm run start:all
