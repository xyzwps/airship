# App Icons

An app SHOULD have two square icons, both committed as files at the root of the app directory:

- `icon.png` — the source image, used as the app window icon.
- `icon.ico` — the multi-size shell icon, used by the OS (taskbar, shortcut, installer).

File names are pure convention; there is no manifest field for icons. Packaging fails loudly when either file is missing.

## `icon.png`

Only this one source image is recognized. Do not place it on a background plate; bake the colors into the image itself. A source of 512×512 or less is recommended.

## `icon.ico`

The standard shape: 7 square frames at **16 / 24 / 32 / 48 / 64 / 128 / 256**, each frame 32-bit color and **PNG-compressed** internally (not the legacy BMP + AND-mask format).
The practical minimum for authors is **16 / 32 / 48 / 256** present. Packaging copies the file as-is and does NOT reject an incomplete frame set — keeping the full set is on you.

Neither packaging nor installation converts icon formats: the `.ico` inside the package is exactly the file stored in the app directory. If you change the source image, re-export the `.ico` yourself.

The built-in **airship-icon** app (Icon Helper) produces both files for you from one source image.
