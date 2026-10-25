# Portability

Installation uses a directory junction and a `.cmd` launcher on Windows;
macOS/Linux retain symlinks. File hard links replace symlink runtime locks.
Optional macOS app icon extraction stays behind `--app`.

Native Windows and Linux live verification is still pending. Manually verify
installation/uninstallation, paths with spaces, crash recovery, browser
launch, and message delivery on native Windows and Linux.

