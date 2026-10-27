# adb quirks — Lecmap Android

## The keyboard shift

The login form is inside a scrolling column. When a field gains focus, Gboard opens and the
whole form moves up by roughly 440px. Bounds read while the keyboard is closed are therefore
wrong for every field below the one you tapped.

Symptoms of using stale bounds:

- Text lands in the wrong field (password typed into email).
- A tap opens the Gboard settings screen instead of a field.
- The login button appears grey because one field never received its value.

Rule: dump → tap → dump → act. One dump per focus change.

## Keyevent cheat sheet

| Acción | Comando |
| --- | --- |
| Select all in focused field | `input keycombination 113 29` |
| Delete selection / backspace | `input keyevent 67` |
| Back | `input keyevent KEYCODE_BACK` |
| Dismiss keyboard | `input keyevent 111` |
| Dump current UI tree | `adb shell uiautomator dump /sdcard/ui.xml` then `cat` it |

Send deletions in a loop with a small `sleep` (0.05s); a burst of bare `keyevent` calls drops
events and leaves residue in the field.

## Shell escaping for `input text`

`adb shell` re-parses the argument on the device. Single quotes on the host keep `@` intact;
escape `!` with a backslash so the device shell does not eat it:

```
adb shell input text 'galantimartin@gmail.com'
adb shell input text 'Martin2350\!'
```

Verify by reading the visible field back — never by printing the password field.

## Reading the UI tree

```sh
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb shell cat /sdcard/ui.xml | tr '>' '>\n' \
  | grep -oE 'class="android.widget.EditText"[^>]*bounds="[^"]*"|text="[^"]+"[^>]*bounds="[^"]*"'
```

## Useful package

- App: `com.notasia.clone`
- Activity: `.MainActivity`
- Cold start: `adb shell am force-stop com.notasia.clone && adb shell am start -n com.notasia.clone/.MainActivity`
