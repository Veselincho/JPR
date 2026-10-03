#!/bin/bash
# =============================================================================
#  JPR – one-shot installer & launcher for macOS
#
#  Usage (paste ONE line in Terminal):
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Veselincho/JPR/main/install.sh)"
#  (or, if you saved the file:   bash ~/Downloads/jpr-mac-setup.sh)
#
#  What it does (safe to re-run any time – it will just update and launch):
#    1. Installs Homebrew (if missing)
#    2. Installs ffmpeg, node, yt-dlp, deno via Homebrew and updates yt-dlp
#    3. Downloads / updates the project from GitHub into ~/JPR
#    4. Runs `npm install`
#    5. Creates a double-clickable "Start JPR.command" on the Desktop
#    6. Starts the app (`npm start`)
# =============================================================================

set -Eeuo pipefail

REPO_URL="https://github.com/Veselincho/JPR.git"
INSTALL_DIR="$HOME/JPR"
LAUNCHER="$HOME/Desktop/Start JPR.command"

# ---------- pretty output ----------------------------------------------------
bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf "\n%s==> %s%s\n" "$bold" "$*" "$reset"; }
ok()   { printf "%s✓ %s%s\n" "$green" "$*" "$reset"; }
warn() { printf "%s! %s%s\n" "$yellow" "$*" "$reset"; }
die()  { printf "\n%s✗ %s%s\n" "$red" "$*" "$reset" >&2; exit 1; }

trap 'die "Something went wrong (script line $LINENO). Scroll up to see the error and send a screenshot to whoever gave you this script."' ERR

# ---------- sanity checks ----------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS only."
[ "$(id -u)" -ne 0 ] || die "Please run this WITHOUT sudo (Homebrew refuses to run as root)."

export HOMEBREW_NO_ENV_HINTS=1
export HOMEBREW_NO_INSTALL_CLEANUP=1

# ---------- 1. Homebrew ------------------------------------------------------
load_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  local p
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$p" ]; then
      eval "$("$p" shellenv)"
      return 0
    fi
  done
  return 1
}

step "Checking Homebrew"
if load_brew; then
  ok "Homebrew is already installed"
else
  warn "Homebrew not found – installing it now."
  warn "It will ask for your Mac password (you won't see it as you type) and for you to press ENTER."
  warn "If a popup about 'Command Line Tools' appears, accept it – this can take several minutes."
  # "</dev/tty" = read the keyboard, not the script (needed if run via "curl | bash")
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  load_brew || die "Homebrew was installed but can't be found. Close Terminal, open it again and re-run this script."
  ok "Homebrew installed"
fi

# Make brew available in future Terminal windows too
BREW_BIN="$(command -v brew)"
touch "$HOME/.zprofile"
if ! grep -qF "brew shellenv" "$HOME/.zprofile"; then
  printf '\neval "$(%s shellenv)"\n' "$BREW_BIN" >> "$HOME/.zprofile"
  ok "Added Homebrew to ~/.zprofile"
fi

# ---------- 2. Dependencies --------------------------------------------------
step "Installing dependencies (ffmpeg, node, yt-dlp, deno)"
for pkg in ffmpeg node yt-dlp deno; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    ok "$pkg already installed"
  else
    brew install "$pkg"
    ok "$pkg installed"
  fi
done

step "Updating yt-dlp (old versions cause 403 errors)"
if brew update --quiet && brew upgrade yt-dlp; then
  ok "yt-dlp is up to date: $(yt-dlp --version)"
else
  warn "Couldn't update yt-dlp (no internet?). Continuing with: $(yt-dlp --version)"
fi

# ---------- 3. Project files -------------------------------------------------
step "Getting the app into $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  if git -C "$INSTALL_DIR" pull --ff-only --quiet; then
    ok "Project updated"
  else
    warn "Couldn't update the project – using the existing copy."
  fi
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR already exists but isn't the JPR project. Rename or delete that folder and run the script again."
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Project downloaded"
fi

# ---------- 4. npm install ---------------------------------------------------
step "Installing app packages (first time takes a few minutes – Electron is ~100 MB)"
cd "$INSTALL_DIR"
npm install --no-audit --no-fund
[ -e "node_modules/.bin/electron" ] || die "Electron didn't install correctly. Check your internet connection and run the script again."
ok "Packages installed"

# ---------- 5. Desktop launcher ----------------------------------------------
make_launcher() {
  [ -d "$HOME/Desktop" ] || return 1
  cat > "$LAUNCHER" <<EOF
#!/bin/bash
# Double-click to start JPR. Updates yt-dlp first so downloads don't break.
for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "\$p" ]; then eval "\$("\$p" shellenv)"; break; fi
done
export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1
cd "$INSTALL_DIR" || exit 1
echo "Updating yt-dlp..."
brew upgrade yt-dlp >/dev/null 2>&1 || echo "(couldn't update yt-dlp, continuing)"
echo "Starting JPR... (close this window to quit)"
npm start
EOF
  chmod +x "$LAUNCHER"
}

step "Creating Desktop shortcut"
if make_launcher; then
  ok "Created \"Start JPR.command\" on your Desktop – double-click it next time"
else
  warn "Couldn't create the Desktop shortcut (not important). Next time just re-run this script."
fi

# ---------- 6. Run -----------------------------------------------------------
step "Starting JPR"
echo "Leave this Terminal window open while the app is running."
trap - ERR
npm start || warn "The app exited with an error. Scroll up to see why."
