# App-local Microsoft Visual C++ runtime (Windows x64)

`x64/*.dll` are the Visual C++ 2015-2022 runtime DLLs **14.44.35211.0**, taken
unmodified from Microsoft's `vc_redist.x64.exe`
(https://aka.ms/vs/17/release/vc_redist.x64.exe, installed in a scratch Wine
prefix and copied from its system32). They are Microsoft "Distributable Code"
that apps may ship app-locally next to the binaries that use them.

`scripts/desktop/stage-bundle.mjs` copies them next to
`onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node` in the
Windows bundle. onnxruntime 1.21 is built with VS 2022 17.10+; with an older
system runtime (e.g. 14.29) its DLL initialisation crashes inside msvcp140
("A dynamic link library (DLL) initialization routine failed") and with no
runtime the binding fails with "The specified module could not be found".
Windows searches the binding's own folder first, so these copies win over
whatever is (or isn't) in System32.

Update: install a newer vc_redist, copy the four DLLs, refresh `x64/SHA256SUMS`.
