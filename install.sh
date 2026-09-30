#!/bin/bash
set -e

echo "================================================="
echo "   Setting up JPR YouTube Downloader for Mac     "
echo "================================================="
echo ""

# Check if Homebrew is installed
if ! command -v brew &>/dev/null; then
  echo "==> Step 1/4: Installing Homebrew..."
  echo "--> If asked for a Password, type your Mac login password and press Enter."
  echo "--> (Note: You won't see letters or dots appear as you type)."
  echo ""
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "==> Step 1/4: Homebrew is already installed!"
fi

echo ""
echo "==> Step 2/4: Setting up environment..."
for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$p" ]; then
    eval "$("$p" shellenv)"
    grep -q "$p shellenv" ~/.zprofile 2>/dev/null || echo "eval \"\$($p shellenv)\"" >> ~/.zprofile
    break
  fi
done

echo ""
echo "==> Step 3/4: Installing Git, Node.js, FFmpeg, and yt-dlp..."
brew install git node ffmpeg yt-dlp

echo ""
echo "==> Step 4/4: Downloading JPR..."
cd ~
if [ -d "JPR" ]; then
  cd JPR && git pull
else
  git clone https://github.com/Veselincho/JPR.git && cd JPR
fi

echo ""
echo "==> Installing dependencies..."
npm install

echo ""
echo "================================================="
echo "   Setup Complete! Starting JPR Downloader...    "
echo "================================================="
npm start