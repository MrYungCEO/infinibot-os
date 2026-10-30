#!/bin/bash
# InfiniBot Desktop .deb postrm (ported from Robovoice Desktop; replaces electron-builder's default template).
# NOTE: electron-builder expands dollar-brace macros (executable, sanitizedProductName);
# shell variables here therefore use the plain $name form.

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# Drop the AppArmor profile on remove/purge (an upgrade's postinst rewrites it).
case "$1" in
    remove|purge)
        APPARMOR_PROFILE='/etc/apparmor.d/${executable}'
        if [ -f "$APPARMOR_PROFILE" ]; then
            if hash apparmor_parser 2>/dev/null; then
                apparmor_parser --remove "$APPARMOR_PROFILE" >/dev/null 2>&1 || true
            fi
            rm -f "$APPARMOR_PROFILE"
        fi
        ;;
esac

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database -q /usr/share/applications || true
fi

exit 0
