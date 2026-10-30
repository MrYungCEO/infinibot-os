#!/bin/bash
# InfiniBot Desktop .deb postinst (ported from Robovoice Desktop; replaces electron-builder's default template).
#
# electron-builder's stock script tests `unshare --user true` and, when that
# works, drops the setuid bit from chrome-sandbox. On Ubuntu 23.10+/24.04 the
# test passes (creating the namespace is allowed) but AppArmor then denies the
# namespace any capabilities (kernel.apparmor_restrict_unprivileged_userns=1),
# so Chromium falls back to the helper, finds it 0755 and aborts:
#   FATAL:setuid_sandbox_host.cc ... chrome-sandbox is owned by root and has mode 4755
# Here the sandbox is fixed both ways, like Google Chrome's own package:
#   1. chrome-sandbox is always root:root 4755 (the setuid fallback works);
#   2. where AppArmor 4 is present, a profile that allows `userns` for our
#      binary is installed, so the preferred namespace sandbox works too.
# NOTE: electron-builder expands dollar-brace macros (executable, sanitizedProductName);
# shell variables here therefore use the plain $name form.

set -e

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# 1. setuid sandbox helper (Chromium only uses it when the namespace sandbox is unavailable).
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

# 2. AppArmor profile granting user namespaces (Ubuntu 24.04+). Only written
#    when the running AppArmor understands the abi/4.0 `userns` rule.
APPARMOR_PROFILE='/etc/apparmor.d/${executable}'
if [ -d /etc/apparmor.d ] && [ -f /etc/apparmor.d/abi/4.0 ] && hash apparmor_parser 2>/dev/null; then
    cat > "$APPARMOR_PROFILE" <<'EOF'
# Installed by the infinibot-desktop package. Allows Chromium's user-namespace
# sandbox for InfiniBot under kernel.apparmor_restrict_unprivileged_userns=1.
# The profile confines nothing else (same shape as Ubuntu's own chrome profile).
abi <abi/4.0>,
include <tunables/global>

profile infinibot-desktop /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/infinibot-desktop>
}
EOF
    chmod 0644 "$APPARMOR_PROFILE"
    # Load it now if AppArmor is running (not in chroots/containers).
    if hash aa-enabled 2>/dev/null && aa-enabled --quiet 2>/dev/null; then
        apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE" || true
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
