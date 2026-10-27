---
name: lecmap-android-login
description: "Trigger: Lecmap Android login, iniciar sesión en la app, loguear Lecmap en el celular, adb login Lecmap. Fill the Lecmap Android login form without breaking on keyboard-driven layout shifts."
license: Apache-2.0
metadata:
  author: "ElTinchoSF"
  version: "1.0"
---

## Activation Contract

Load this skill before any `adb` interaction that must reach the logged-in state of the Lecmap Android app (package `com.notasia.clone`). Use it whenever the screen shows `Email` / `Contraseña` / `Iniciar sesión`, or whenever a session must be restored after a force-stop, a logout, or an expired token.

## Hard Rules

- Never type into a field using bounds captured before the keyboard opened. Focusing a text field opens Gboard and shifts every field upward, so stale bounds land on the wrong control.
- Re-run `uiautomator dump` after **every** tap that focuses a text field, and trust only the newest bounds.
- Clear a field with `input keycombination 113 29` (Ctrl+A) before typing, so the new value replaces the old instead of appending to it.
- Read credentials from `.credentials`; never echo the password into output, logs, screenshots or commit messages.
- If `Iniciar sesión` stays grey, a field is empty: re-dump and re-fill. Do not tap the button repeatedly.

## Decision Gates

| Estado observado | Acción |
| --- | --- |
| `Iniciar sesión` visible | Run Execution Steps |
| `Salir` ya visible en el header | Return `login: already authenticated`; touch nothing |
| Credenciales rechazadas | Stop and ask the user; never retry in a loop |
| Otro error en pantalla | Screenshot, return its text, stop |

## Execution Steps

1. `adb shell am start -n com.notasia.clone/.MainActivity`, wait 5s.
2. Dump and classify per Decision Gates.
3. Read `EMAIL=` and `PASSWORD=` from `.credentials`. If missing, ask the user for them.
4. Dump → tap Email → dump again → `input keycombination 113 29` → `input text "$EMAIL"`.
5. Dump → tap Contraseña at the fresh bounds → dump → select-all → `input text "$PASSWORD"`.
6. Dump → tap `Iniciar sesión` at the fresh bounds → wait 8s.
7. Dump again: success is `Salir` present with no error banner.

## Output Contract

Return exactly one line: `login: ok`, `login: already authenticated`, or `login: failed — <visible error>`, plus the path of the last screenshot when one was taken.

## References

- `references/adb-quirks.md` — keyevent cheatsheet and the keyboard-shift mechanics.
